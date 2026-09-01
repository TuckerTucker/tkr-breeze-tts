/**
 * The local gateway.
 *
 * The browser talks only to this process, on localhost, same-origin with the
 * UI it serves. That single decision removes three problems at once: the Modal
 * credential never reaches page source, CORS never arises, and the `.modal.run`
 * URL is never published. It also gives a natural home for the two chores the
 * browser is bad at — transcoding recorded audio, and caching clips.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import pino, { type Logger } from 'pino';

import {
  ConfigError,
  loadConfig,
  redact,
  type GatewayConfig,
} from './config.js';
import { ClipCache } from './cache.js';
import type { ClipRequest, VoiceMode } from './cache-index.js';
import { GatewayError, ModalProxy } from './proxy.js';
import {
  FFMPEG_INSTALL_REMEDY,
  ReferenceError as RefError,
  checkFfmpeg,
  normaliseReference,
  validateReferencePair,
  type FfmpegStatus,
} from './reference.js';
import {
  durationSeconds,
  frameWav,
  parseAudioFormat,
  type AudioFormat,
} from './transport.js';
import { VoiceStore } from './voices.js';
import { suggestNameFromInstruction } from './voices-index.js';
import {
  MAX_CUE_TOKENS,
  ScriptStore,
  CEILING_BY_BATCH,
  ceilingRefusal,
  findCeilingBreach,
  concatenateScript,
  exportVtt,
  refreshScript,
  type Cue,
} from './script.js';
import { runScript } from './cue-queue.js';

/**
 * The server's concrete type. Spelled out because the instance carries a real
 * pino `Logger` rather than Fastify's structural `FastifyBaseLogger`, and an
 * exported function should say what it returns.
 */
export type GatewayServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

/** Everything the server needs, injected so it can be built for a test. */
export interface ServerDeps {
  readonly config: GatewayConfig;
  readonly logger: Logger;
  readonly proxy: ModalProxy;
  readonly cache: ClipCache;
  readonly voices: VoiceStore;
  readonly scripts: ScriptStore;
  readonly ffmpeg: FfmpegStatus;
}

/** The conservative CFG control, used until the fall-off probe has run. */
export const DEFAULT_CFG_CONTROL = {
  kind: 'presets' as const,
  values: [1.0, 4.0],
  default: 1.0,
};

interface SpeechFields {
  text: string;
  instruction: string;
  cfgScale: number;
  seed: number;
  mode: VoiceMode;
  refText: string | undefined;
  refAudio: Buffer | undefined;
  refFilename: string | undefined;
  voiceId: string | undefined;
}

function asVoiceMode(value: string | undefined): VoiceMode {
  return value === 'clone' || value === 'direction' ? value : 'design';
}

/**
 * Read a recorded finding from `bench/findings`, tolerating its absence.
 *
 * Absence is a first-class case: the UI must say a figure is "not yet
 * measured" rather than invent one.
 *
 * @param dir - The findings directory.
 * @param name - The file to read.
 * @returns The parsed finding, or null.
 */
export async function readFinding(
  dir: string,
  name: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(dir, name), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Name a mid-generation upstream abort.
 *
 * Upstream commits to a `200`, streams, and then closes: the reason stays in
 * the service's own log and nothing about it crosses the wire. What arrives
 * here is undici's `terminated`, which describes the socket rather than the
 * failure — passing it through put the bare word "terminated" in front of an
 * operator as the whole explanation.
 *
 * Deliverable only while the reply is still retractable, which is the common
 * case: the vendor raises while building its branch batch, before any audio.
 * Once audio is on the wire this becomes the truncation the player reports.
 *
 * @param received - Audio bytes that did arrive before the close.
 * @returns A typed failure naming what was observed, and no more.
 */
function streamAbortError(received: number): GatewayError {
  if (received === 0) {
    return new GatewayError(
      'upstream',
      'the service accepted the request and then closed the stream without sending audio',
      {
        remedy:
          'The fault stayed upstream and only its own log carries the reason. This shape is ' +
          'usually an input with no captured CUDA graph behind it — shorten the line, or ' +
          'change CFG, then try again.',
      },
    );
  }
  return new GatewayError(
    'upstream',
    `the service closed the stream after ${received} bytes, so this clip is incomplete`,
    {
      remedy:
        'The partial audio was discarded rather than cached as though it were a whole clip. ' +
        'Generate again.',
    },
  );
}

/**
 * Deliver a typed failure, or sever the connection when one can no longer be
 * delivered.
 *
 * `POST /api/speech` commits its reply to `audio/pcm` and hands Fastify a
 * stream, so a fault raised after that point has no body left to occupy.
 * Answering it with a JSON object earns `FST_ERR_REP_INVALID_PAYLOAD_TYPE` and
 * serves the client a second, misleading failure stacked on the first — which
 * is what a mid-flight upstream abort used to produce. Once bytes are on the
 * wire the only signal still available is to destroy the socket, and it is a
 * true one: the client's read throws, and the player reports the clip as
 * incomplete rather than short.
 *
 * @param reply - The reply to answer on.
 * @param error - What went wrong.
 * @param config - Supplies the redaction that keeps the endpoint out of the
 *   message.
 * @param log - Records a severed connection, which leaves no response to read.
 */
function sendError(
  reply: FastifyReply,
  error: unknown,
  config: GatewayConfig,
  log?: Logger,
): void {
  if (reply.raw.headersSent) {
    log?.warn(
      { err: error },
      'response already committed; severing the connection instead of a typed error',
    );
    reply.raw.destroy();
    return;
  }
  // A route may have already declared an audio content type without having sent
  // anything under it. A JSON failure cannot be serialised beneath that
  // declaration, so it is withdrawn here rather than at each throw site.
  reply.type('application/json');
  if (error instanceof GatewayError) {
    reply.code(error.statusCode).send(error.toJSON());
    return;
  }
  if (error instanceof RefError) {
    reply.code(error.kind === 'ffmpeg-missing' ? 503 : 400).send({
      error: {
        type: 'reference',
        kind: error.kind,
        message: error.message,
        ...(error.remedy ? { remedy: error.remedy } : {}),
      },
    });
    return;
  }
  const message = redact(
    error instanceof Error ? error.message : String(error),
    config,
  );
  reply.code(500).send({ error: { type: 'upstream', message } });
}

/**
 * Build the HTTP server.
 *
 * @param deps - Configuration and the collaborators it drives.
 * @returns A configured Fastify instance, not yet listening.
 */
export function createServer(deps: ServerDeps): GatewayServer {
  const { config, logger, proxy, cache, voices, scripts, ffmpeg } = deps;
  const app = Fastify({ loggerInstance: logger, bodyLimit: 64 * 1024 * 1024 });

  app.register(multipart, {
    limits: { fileSize: 64 * 1024 * 1024, files: 1 },
  });

  app.setErrorHandler((error, request, reply) => {
    sendError(reply, error, config, request.log as Logger);
  });

  /**
   * Library transcripts by voice id.
   *
   * One lookup serves both questions a cue asks — whether its voice still
   * exists, and what that voice's reference transcript is — so the two can
   * never be answered from different reads of the store.
   *
   * @returns Transcript by voice id, for every visible voice.
   */
  const voiceTranscripts = (): ReadonlyMap<string, string> =>
    new Map(voices.list().map((voice) => [voice.id, voice.transcript]));

  // ── Health and readiness ─────────────────────────────────────────────────
  //
  // Deliberately does not touch upstream. `/health` on a scaled-to-zero
  // container *starts* one, so polling it to find out whether a cold start is
  // due would cause the cold start it was checking for.
  app.get('/api/health', async () => {
    const latency = await readFinding(config.findingsDir, 'latency.json');
    const summary = (latency?.summary ?? null) as Record<string, any> | null;
    return {
      readiness: proxy.readiness(),
      lastUpstreamAt: proxy.lastSuccessAt,
      scaledownWindowMs: config.scaledownWindowMs,
      transport: config.transport,
      ffmpeg: {
        available: ffmpeg.available,
        remedy: ffmpeg.available ? null : FFMPEG_INSTALL_REMEDY,
      },
      cache: { enabled: cache.enabled, clips: cache.list().length, bytes: cache.totalBytes() },
      voices: voices.list().length,
      limits: { maxTokens: MAX_CUE_TOKENS, tokenCeilingByBatch: CEILING_BY_BATCH },
      // Null rather than a placeholder: the UI says "not yet measured".
      measured: summary
        ? {
            warmupMs: summary.warmup_ms ?? null,
            coldTtfaMs: summary.cold?.ttfa_ms_median ?? null,
            warmTtfaMs: summary.warm?.ttfa_ms_median ?? null,
            rtf: summary.warm?.rtf_median ?? null,
          }
        : null,
    };
  });

  /** Deliberately wakes the container. An action, never a poll. */
  app.post('/api/wake', async () => {
    const health = await proxy.health();
    return { readiness: proxy.readiness(), upstream: health };
  });

  app.get('/api/findings', async () => {
    const cfg = await readFinding(config.findingsDir, 'cfg-falloff.json');
    if (!cfg) {
      return {
        measured: false,
        verdict: 'unmeasured',
        rationale:
          'The cfg fall-off probe has not run against this deployment. Presenting a ' +
          'slider whose latency behaviour is unverified would contradict the claim ' +
          'the demo is making, so the conservative control is used.',
        cfgControl: DEFAULT_CFG_CONTROL,
        capturedCfgScales: DEFAULT_CFG_CONTROL.values,
      };
    }
    return {
      measured: true,
      verdict: cfg.verdict,
      rationale: cfg.rationale,
      cfgControl: cfg.cfg_control ?? DEFAULT_CFG_CONTROL,
      capturedCfgScales: cfg.captured_cfg_scales ?? DEFAULT_CFG_CONTROL.values,
      tokenCeiling: cfg.token_ceiling ?? null,
      measuredAt: cfg.measured_at ?? null,
    };
  });

  // ── Synthesis ────────────────────────────────────────────────────────────
  app.post('/api/speech', async (request, reply) => {
    const fields = await readSpeechFields(request as never);

    if (!fields.text.trim()) {
      throw new GatewayError('validation', 'there is nothing to speak');
    }
    let refAudio: Buffer | undefined;
    let refText = fields.refText;

    if (fields.voiceId) {
      const voice = await voices.read(fields.voiceId);
      // Both halves, together, from one read. A library request is structurally
      // incapable of being the half-formed pair the vendor rejects.
      refAudio = voice.wav;
      refText = voice.record.transcript;
    } else if (fields.refAudio) {
      refAudio = await normaliseReference(fields.refAudio, {
        ffmpegAvailable: ffmpeg.available,
      });
    }

    validateReferencePair({ hasAudio: Boolean(refAudio), refText });

    // After the reference is resolved, not before: a library voice supplies the
    // transcript, and the transcript is a text segment. Checking ahead of this
    // is what let a 2707-character one through to raise `(2, 640)` on the GPU.
    const breach = findCeilingBreach({
      mode: fields.mode,
      cfgScale: fields.cfgScale,
      text: fields.text,
      instruction: fields.instruction,
      ...(refText ? { refText } : {}),
    });
    if (breach) {
      const refusal = ceilingRefusal(breach, fields.mode);
      throw new GatewayError('validation', refusal.message, { remedy: refusal.remedy });
    }

    const startedAt = performance.now();
    const upstream = await proxy.speech({
      text: fields.text,
      instruction: fields.instruction,
      cfgScale: fields.cfgScale,
      seed: fields.seed,
      ...(refAudio && refText ? { refAudio, refText } : {}),
    });

    let format: AudioFormat;
    try {
      format = parseAudioFormat(upstream.headers);
    } catch (error) {
      throw new GatewayError('format', (error as Error).message, {
        remedy: 'The service must send X-Sample-Rate and X-Sample-Format.',
      });
    }

    const provenance: ClipRequest = {
      text: fields.text,
      instruction: fields.instruction,
      mode: fields.mode,
      cfgScale: fields.cfgScale,
      seed: fields.seed,
      ...(refText ? { refText } : {}),
      ...(fields.voiceId ? { voiceId: fields.voiceId } : {}),
    };

    const writer = cache.beginWrite();
    reply.header('X-Clip-Id', writer.id);
    reply.header('X-Sample-Rate', String(format.sampleRate));
    reply.header('X-Sample-Format', format.format);
    reply.header('Cache-Control', 'no-store');

    if (config.transport === 'buffered') {
      const chunks: Buffer[] = [];
      let ttfaMs: number | null = null;
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        if (ttfaMs === null) ttfaMs = performance.now() - startedAt;
        const buffer = Buffer.from(chunk);
        chunks.push(buffer);
        writer.write(buffer);
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.length === 0) {
        await writer.abort();
        // Never a truncated WAV claiming a full length: it plays, and it lies.
        throw new GatewayError('upstream', 'the service returned no audio');
      }
      await writer.finalize({
        format,
        ttfaMs,
        transport: config.transport,
        request: provenance,
      });
      reply.header('X-First-Byte-Ms', String(Math.round(ttfaMs ?? 0)));
      reply.type('audio/wav');
      return reply.send(frameWav(pcm, format));
    }

    // Streaming: no buffering, no transformation. Any accumulation here would
    // silently discard the sub-40ms claim that justifies the GPU.
    reply.type('audio/pcm');
    const source = Readable.fromWeb(upstream.body as never);
    let ttfaMs: number | null = null;
    let received = 0;
    const tee = new Readable({
      read(): void {},
    });
    (async () => {
      try {
        for await (const chunk of source) {
          if (ttfaMs === null) ttfaMs = performance.now() - startedAt;
          received += (chunk as Uint8Array).byteLength;
          tee.push(chunk);
          writer.write(chunk as Uint8Array);
        }
        // Finalise *before* ending the response. Every audio byte has already
        // been pushed to the client, so this delays neither first nor last
        // audio — it only holds the connection open for the sidecar write, and
        // that is what makes the clip present in the cache index by the time
        // the client's request settles and it reloads history.
        await writer.finalize({
          format,
          ttfaMs,
          transport: config.transport,
          request: provenance,
        });
        tee.push(null);
      } catch (error) {
        logger.warn({ err: error, received }, 'upstream stream aborted mid-flight');
        // The socket-level cause is logged; what travels onward is the named
        // condition, since undici's wording reaches an operator as an
        // explanation and does not work as one.
        tee.destroy(streamAbortError(received));
        await writer.abort();
      }
    })();
    return reply.send(tee);
  });

  // ── Clips ────────────────────────────────────────────────────────────────
  app.get('/api/clips', async () => ({ clips: cache.list() }));

  app.get<{ Params: { id: string } }>('/api/clips/:id', async (request, reply) => {
    const wav = await cache.readWav(request.params.id);
    if (!wav) throw new GatewayError('not-found', 'that clip is no longer cached');
    const record = cache.get(request.params.id);
    reply.type('audio/wav');
    reply.header('X-Sample-Rate', String(record?.sampleRate ?? ''));
    reply.header(
      'Content-Disposition',
      `attachment; filename="${filenameFor(record?.request.text ?? 'clip')}.wav"`,
    );
    return reply.send(wav);
  });

  app.delete<{ Params: { id: string } }>('/api/clips/:id', async (request) => ({
    removed: await cache.remove(request.params.id),
  }));

  // ── Voices ───────────────────────────────────────────────────────────────
  app.get('/api/voices', async () => {
    const list = voices.list();
    const withAvailability = await Promise.all(
      list.map(async (voice) => ({
        ...voice,
        available: await voices.isAvailable(voice.id),
      })),
    );
    return { voices: withAvailability };
  });

  app.post('/api/voices', async (request) => {
    const contentType = request.headers['content-type'] ?? '';
    if (contentType.includes('multipart/form-data')) {
      const fields = await readSpeechFields(request as never);
      if (!fields.refAudio) {
        throw new GatewayError('validation', 'no audio file was supplied');
      }
      // Same normalisation as reference intake, so every stored voice is a
      // conforming WAV whatever it arrived as.
      const wav = await normaliseReference(fields.refAudio, {
        ffmpegAvailable: ffmpeg.available,
      });
      return voices.create({
        wav,
        transcript: fields.refText ?? '',
        name: fields.instruction || fields.refFilename || 'Uploaded voice',
        origin: {
          kind: 'cloned',
          ...(fields.refFilename ? { sourceFilename: fields.refFilename } : {}),
        },
      });
    }

    const body = (request.body ?? {}) as {
      clipId?: string;
      name?: string;
      transcript?: string;
      defaultDirection?: string | null;
    };
    if (!body.clipId) {
      throw new GatewayError('validation', 'a clipId or an uploaded file is required');
    }
    const clip = cache.get(body.clipId);
    return voices.createFromClip({
      cache,
      clipId: body.clipId,
      name: body.name || suggestNameFromInstruction(clip?.request.instruction),
      ...(body.transcript ? { transcript: body.transcript } : {}),
      ...(body.defaultDirection !== undefined
        ? { defaultDirection: body.defaultDirection }
        : {}),
    });
  });

  app.patch<{ Params: { id: string } }>('/api/voices/:id', async (request) => {
    const body = (request.body ?? {}) as {
      name?: string;
      defaultDirection?: string | null;
      transcript?: string;
      restore?: boolean;
    };
    if (body.restore) return voices.restore(request.params.id);
    return voices.update(request.params.id, body);
  });

  app.delete<{ Params: { id: string } }>('/api/voices/:id', async (request) => {
    // Immediate, with an undo window. Never a confirmation dialog.
    const record = await voices.remove(request.params.id);
    return { deleted: record.id, undoWindowMs: 30_000 };
  });

  app.get<{ Params: { id: string } }>('/api/voices/:id/audio', async (request, reply) => {
    const voice = await voices.read(request.params.id);
    reply.type('audio/wav');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${filenameFor(voice.record.name)}.wav"`,
    );
    return reply.send(voice.wav);
  });

  // ── Scripts ──────────────────────────────────────────────────────────────
  app.post('/api/scripts', async (request) => {
    const contentType = request.headers['content-type'] ?? '';
    let source = '';
    let filename: string | undefined;

    if (contentType.includes('multipart/form-data')) {
      for await (const part of (request as never as { parts(): AsyncIterable<any> }).parts()) {
        if (part.type === 'file') {
          source = (await part.toBuffer()).toString('utf8');
          filename = part.filename;
        }
      }
    } else {
      const body = (request.body ?? {}) as { source?: string; filename?: string };
      source = body.source ?? '';
      filename = body.filename;
    }
    if (!source.trim()) {
      throw new GatewayError('validation', 'the dropped file was empty');
    }
    return scripts.importFile({ source, ...(filename ? { filename } : {}) });
  });

  app.get('/api/scripts', async () => ({ scripts: scripts.list() }));

  app.get<{ Params: { id: string } }>('/api/scripts/:id', async (request) =>
    refreshScript(scripts.require(request.params.id), {
      cache,
      voiceTranscripts: voiceTranscripts(),
    }),
  );

  app.patch<{ Params: { id: string; cueId: string } }>(
    '/api/scripts/:id/cues/:cueId',
    async (request) => {
      const updated = await scripts.patchCue(
        request.params.id,
        request.params.cueId,
        (request.body ?? {}) as never,
      );
      return refreshScript(updated, {
        cache,
        voiceTranscripts: voiceTranscripts(),
      });
    },
  );

  app.put<{ Params: { id: string } }>('/api/scripts/:id/cues', async (request) => {
    const body = (request.body ?? {}) as { cues: Cue[] };
    const updated = await scripts.replaceCues(request.params.id, body.cues ?? []);
    return refreshScript(updated, {
      cache,
      voiceTranscripts: voiceTranscripts(),
    });
  });

  app.delete<{ Params: { id: string } }>('/api/scripts/:id', async (request) => ({
    removed: await scripts.remove(request.params.id),
  }));

  app.post<{ Params: { id: string } }>('/api/scripts/:id/run', async (request, reply) => {
    const script = scripts.require(request.params.id);
    const transcripts = voiceTranscripts();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    const summary = await runScript({
      script,
      cache,
      voiceTranscripts: transcripts,
      logger,
      onProgress: (progress) => {
        reply.raw.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`);
      },
      synthesize: (cue) => synthesizeCue(cue, { proxy, cache, voices, config }),
    });

    await scripts.save(script);
    reply.raw.write(`event: done\ndata: ${JSON.stringify(summary)}\n\n`);
    reply.raw.end();
    return reply;
  });

  app.get<{ Params: { id: string } }>('/api/scripts/:id/export.vtt', async (request, reply) => {
    const script = refreshScript(scripts.require(request.params.id), {
      cache,
      voiceTranscripts: voiceTranscripts(),
    });
    reply.type('text/vtt');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${filenameFor(script.name)}.vtt"`,
    );
    return reply.send(exportVtt(script));
  });

  app.get<{ Params: { id: string } }>('/api/scripts/:id/export.wav', async (request, reply) => {
    const script = refreshScript(scripts.require(request.params.id), {
      cache,
      voiceTranscripts: voiceTranscripts(),
    });
    reply.type('audio/wav');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${filenameFor(script.name)}.wav"`,
    );
    return reply.send(await concatenateScript(script, cache));
  });

  // ── The UI, same-origin ──────────────────────────────────────────────────
  if (existsSync(config.uiDir)) {
    app.register(fastifyStatic, { root: config.uiDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: { type: 'not-found', message: 'no such route' } });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}

/**
 * Generate one script cue, reusing the same request path as the console.
 *
 * @param cue - The cue to voice.
 * @param deps - The proxy, cache, voice store and configuration.
 * @returns The cue's clip id and generated duration.
 */
async function synthesizeCue(
  cue: Cue,
  deps: {
    proxy: ModalProxy;
    cache: ClipCache;
    voices: VoiceStore;
    config: GatewayConfig;
  },
): Promise<{ clipId: string; durationSeconds: number }> {
  let refAudio: Buffer | undefined;
  let refText: string | undefined;
  let instruction = 'Speak clearly and naturally.';

  if (cue.voiceId) {
    const voice = await deps.voices.read(cue.voiceId);
    refAudio = voice.wav;
    refText = voice.record.transcript;
    instruction = voice.record.defaultDirection ?? instruction;
  }

  const startedAt = performance.now();
  const upstream = await deps.proxy.speech({
    text: cue.text,
    instruction,
    cfgScale: cue.cfgScale,
    seed: cue.seed,
    ...(refAudio && refText ? { refAudio, refText } : {}),
  });
  const format = parseAudioFormat(upstream.headers);

  const chunks: Buffer[] = [];
  let ttfaMs: number | null = null;
  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    if (ttfaMs === null) ttfaMs = performance.now() - startedAt;
    chunks.push(Buffer.from(chunk));
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length === 0) throw new GatewayError('upstream', 'the service returned no audio');

  await deps.cache.put(pcm, {
    id: cue.clipId,
    format,
    ttfaMs,
    transport: deps.config.transport,
    request: {
      text: cue.text,
      instruction,
      mode: cue.voiceId ? 'clone' : 'design',
      cfgScale: cue.cfgScale,
      seed: cue.seed,
      ...(refText ? { refText } : {}),
      ...(cue.voiceId ? { voiceId: cue.voiceId } : {}),
      ...(cue.voiceName ? { voiceName: cue.voiceName } : {}),
    },
  });

  return { clipId: cue.clipId, durationSeconds: durationSeconds(pcm.length, format) };
}

/**
 * Read synthesis fields from either encoding.
 *
 * The browser sends `multipart/form-data` because a reference recording is a
 * file; JSON is accepted too so the same route is reachable from a shell
 * without constructing a multipart body by hand. The field names are the
 * vendor's own, so what the gateway forwards is legible against its docs.
 *
 * @param request - The incoming request.
 * @returns The parsed fields, with defaults applied.
 */
async function readSpeechFields(request: {
  headers: Record<string, unknown>;
  body?: unknown;
  parts(): AsyncIterable<any>;
}): Promise<SpeechFields> {
  const values: Record<string, string> = {};
  let refAudio: Buffer | undefined;
  let refFilename: string | undefined;

  const contentType = String(request.headers['content-type'] ?? '');
  if (contentType.includes('multipart/form-data')) {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        refAudio = await part.toBuffer();
        refFilename = part.filename;
      } else {
        values[part.fieldname] = String(part.value ?? '');
      }
    }
  } else {
    for (const [key, value] of Object.entries((request.body ?? {}) as Record<string, unknown>)) {
      if (value !== undefined && value !== null) values[key] = String(value);
    }
  }

  const cfgScale = Number(values.cfg_scale ?? '1');
  const seed = Number(values.seed ?? '42');
  return {
    text: values.text ?? '',
    instruction: values.instruction ?? 'Speak clearly and naturally.',
    cfgScale: Number.isFinite(cfgScale) && cfgScale > 0 ? cfgScale : 1,
    seed: Number.isInteger(seed) ? seed : 42,
    mode: asVoiceMode(values.mode),
    refText: values.ref_text || undefined,
    refAudio,
    refFilename,
    voiceId: values.voice_id || undefined,
  };
}

/**
 * Derive a filename from the text that produced a clip.
 *
 * @param text - Source text or voice name.
 * @returns A safe, recognisable slug.
 */
export function filenameFor(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'clip';
}

/**
 * Verify the deployment posture without waking a GPU.
 *
 * An *unauthenticated* request proves two things for free: the endpoint is
 * reachable, and proxy auth is actually enforced. Modal rejects it at the edge
 * and never starts a container. An authenticated preflight would prove the
 * pair is accepted, but it would also start a container — roughly twenty times
 * the cost of the generation it precedes — on every gateway start.
 *
 * @param config - The gateway configuration.
 * @param logger - Where to report what was found.
 * @param fetchImpl - Injected fetch, for tests.
 * @returns Whether the endpoint is reachable and closed to the public.
 */
export async function preflight(
  config: GatewayConfig,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<{ reachable: boolean; proxyAuthEnforced: boolean }> {
  try {
    const response = await fetchImpl(`${config.endpoint}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    const enforced = response.status === 401 || response.status === 403;
    if (!enforced) {
      logger.warn(
        { status: response.status },
        'the Modal endpoint answered an unauthenticated request. requires_proxy_auth ' +
          'appears to be off, and the Breeze-TTS-2 weights are research / non-commercial. ' +
          'Redeploy with BREEZE_REQUIRES_PROXY_AUTH=1.',
      );
    }
    return { reachable: true, proxyAuthEnforced: enforced };
  } catch (error) {
    logger.error(
      { err: redact(String(error), config) },
      'the Modal endpoint is unreachable. Check MODAL_ENDPOINT_URL, or deploy with: modal deploy infra/service.py',
    );
    return { reachable: false, proxyAuthEnforced: false };
  }
}

/**
 * Start the gateway.
 *
 * Every precondition is checked before the port is bound. A missing
 * credential, an unreachable endpoint or an absent ffmpeg each surface here,
 * with the remedy named, rather than at the operator's first synthesis.
 *
 * @returns Nothing; the process either serves or exits.
 */
export async function main(): Promise<void> {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    // Belt and braces. The pair is never put in a log line, and this makes an
    // accidental one unreadable rather than merely unlikely.
    redact: {
      paths: ['req.headers["modal-key"]', 'req.headers["modal-secret"]', '*.key', '*.secret'],
      censor: '[redacted]',
    },
  });

  let config: GatewayConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(`gateway cannot start: ${error.message}`);
      logger.error(error.remedy);
      process.exit(1);
    }
    throw error;
  }

  const ffmpeg = await checkFfmpeg();
  if (!ffmpeg.available) {
    // Not fatal: uploads of existing WAV files still work, replay still works,
    // and the UI disables microphone capture with the reason shown. Reported
    // now rather than at first use.
    logger.warn(
      { remedy: FFMPEG_INSTALL_REMEDY },
      'ffmpeg is not installed. Recorded audio and non-WAV uploads cannot be converted.',
    );
  }

  const cache = new ClipCache({
    dir: config.clipCacheDir,
    maxBytes: config.clipCacheMaxBytes,
    logger,
  });
  const voices = new VoiceStore({ dir: config.voiceStoreDir, logger });
  const scripts = new ScriptStore({ dir: config.scriptStoreDir, logger });

  await Promise.all([cache.load(), voices.load(), scripts.load()]);
  await preflight(config, logger);

  const proxy = new ModalProxy({ config, logger });
  const app = createServer({ config, logger, proxy, cache, voices, scripts, ffmpeg });

  await app.listen({ port: config.port, host: '127.0.0.1' });
  const uiPresent = existsSync(config.uiDir);
  logger.info(
    {
      port: config.port,
      transport: config.transport,
      ui: uiPresent ? 'served' : 'not built (run: npm --prefix ui run build)',
      ffmpeg: ffmpeg.available,
    },
    `gateway listening on http://127.0.0.1:${config.port}`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
