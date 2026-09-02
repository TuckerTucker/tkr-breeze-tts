/** Scripts workspace: persistent documents, common delivery, explicit cue exceptions. */

import { useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react';

import { ScriptPreviewPlayer } from './ScriptPreviewPlayer.js';

import {
  CUE_STATE_LABEL,
  INITIAL_SCRIPT_DEFAULTS,
  driftLabel,
  effectiveCueSettings,
  formatTarget,
  progressOf,
  targetSeconds,
  type Cue,
  type CueOverrides,
  type CuePatch,
  type Script,
  type ScriptDefaults,
  type ScriptSummary,
} from '../state/script.js';
import type { Voice } from '../state/voices.js';

/** Props for the persistent top-level script tool. */
export interface ScriptsWorkspaceProps {
  readonly summaries: readonly ScriptSummary[];
  readonly script: Script | null;
  readonly voices: readonly Voice[];
  readonly running: boolean;
  readonly loading: boolean;
  readonly problem: string | null;
  readonly onOpen: (id: string) => void;
  readonly onImport: (source: string, filename: string) => void;
  readonly onCreate: () => void;
  readonly onUpdateDefaults: (patch: Partial<ScriptDefaults>) => void;
  readonly onEditCue: (cueId: string, patch: CuePatch) => void;
  readonly onRun: () => void;
  readonly onExport: (format: 'vtt' | 'wav') => void;
  /** Cached WAV route for one generated cue. */
  readonly clipUrl: (id: string) => string;
}

function overridePatch<K extends keyof CueOverrides>(
  key: K,
  value: CueOverrides[K],
): CuePatch {
  return { overrides: { [key]: value } as Pick<CueOverrides, K> };
}

/**
 * Render document navigation, defaults, exceptions, progress, drift, and exports.
 *
 * @param props - Script summaries, active document, and injected persistence actions.
 * @returns The Scripts tool.
 */
export function ScriptsWorkspace(props: ScriptsWorkspaceProps): JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null);
  const previewPlayer = useRef<HTMLAudioElement>(null);
  const [previewCueId, setPreviewCueId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const defaults = props.script?.defaults ?? INITIAL_SCRIPT_DEFAULTS;
  const readyCues = props.script?.cues.filter((cue) => cue.state === 'done') ?? [];
  const previewCue =
    readyCues.find((cue) => cue.id === previewCueId) ?? readyCues[0] ?? null;
  const previewSource = previewCue ? props.clipUrl(previewCue.clipId) : null;

  useEffect(() => {
    previewPlayer.current?.pause();
    setPreviewCueId(null);
    setPreviewLoading(false);
    setPreviewPlaying(false);
    setPreviewProblem(null);
  }, [props.script?.id]);

  const preview = (cue: Cue): void => {
    if (cue.state !== 'done') return;

    const player = previewPlayer.current;
    if (!player) return;

    if (previewCue?.id === cue.id && !player.paused) {
      player.pause();
      return;
    }

    const source = props.clipUrl(cue.clipId);
    setPreviewCueId(cue.id);
    setPreviewProblem(null);
    setPreviewLoading(true);

    if (player.getAttribute('src') !== source) {
      player.src = source;
      player.load();
    }

    void player.play().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Playback could not start.';
      setPreviewLoading(false);
      setPreviewPlaying(false);
      setPreviewProblem(`${message} The generated cue remains available in the player.`);
    });
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) props.onImport(await file.text(), file.name);
  };

  return (
    <section
      id="workspace-panel-scripts"
      role="tabpanel"
      aria-labelledby="workspace-tab-scripts"
      className="workspace"
    >
      <div className="workspace__heading">
        <div>
          <p className="eyebrow">Open · Direct · Produce</p>
          <h2>Scripts</h2>
          <p>Set the common delivery once. Override only the lines that should differ.</p>
        </div>
        <div className="row">
          <button type="button" className="secondary-action" onClick={() => fileInput.current?.click()}>Import</button>
          <button type="button" className="primary-action" onClick={props.onCreate}>New script</button>
          <input ref={fileInput} hidden type="file" accept=".vtt,.txt,text/plain,text/vtt" aria-label="Import script" onChange={(event) => void importFile(event)} />
        </div>
      </div>

      <div className="scripts-layout">
        <aside className="document-list" aria-label="Script documents">
          <div className="section-heading section-heading--compact">
            <div><p className="step-label">Documents</p><h3>{props.summaries.length}</h3></div>
          </div>
          {props.summaries.length === 0 ? (
            <button type="button" className="empty-state empty-state--compact" onClick={props.onCreate}>
              <strong>Start a script</strong><span>Or import VTT / plain text.</span>
            </button>
          ) : (
            <ul>
              {props.summaries.map((summary) => (
                <li key={summary.id}>
                  <button
                    type="button"
                    aria-current={props.script?.id === summary.id ? 'page' : undefined}
                    onClick={() => props.onOpen(summary.id)}
                  >
                    <strong>{summary.name}</strong>
                    <span>{summary.cueCount} cues · {summary.doneCount} ready{summary.failedCount ? ` · ${summary.failedCount} need attention` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="script-document">
          {props.loading && <p className="document-status" role="status">Loading document…</p>}
          {!props.loading && !props.script && (
            <div className="document-blank">
              <p className="step-label">No document open</p>
              <h3>Choose a script or begin a new one.</h3>
              <p>Your last open document returns automatically on the next visit.</p>
            </div>
          )}

          {props.script && (
            <>
              <div className="script-header">
                <div><p className="step-label">Open document</p><h3>{props.script.name}</h3></div>
                <p role="status" aria-label="Script progress">
                  {progressOf(props.script).done} of {progressOf(props.script).total} ready
                </p>
              </div>

              {props.script.chunking && props.script.chunking.splitSourceCueCount > 0 && (
                <p className="script-import-report" role="status" aria-label="Script import details">
                  <strong>
                    {props.script.chunking.splitSourceCueCount}{' '}
                    {props.script.chunking.splitSourceCueCount === 1 ? 'long line was' : 'long lines were'} split.
                  </strong>{' '}
                  Prepared {props.script.chunking.outputCueCount} generation cues from{' '}
                  {props.script.chunking.sourceCueCount} source{' '}
                  {props.script.chunking.sourceCueCount === 1 ? 'line' : 'lines'}, using sentence,
                  clause, word, or character boundaries to stay within the{' '}
                  {props.script.chunking.tokenCeiling}-token request ceiling.
                </p>
              )}

              <ScriptPreviewPlayer
                cue={previewCue}
                source={previewSource}
                playerRef={previewPlayer}
                loading={previewLoading}
                playing={previewPlaying}
                problem={previewProblem}
                onPlay={() => {
                  setPreviewLoading(true);
                  setPreviewProblem(null);
                }}
                onPlaying={() => {
                  setPreviewLoading(false);
                  setPreviewPlaying(true);
                }}
                onPause={() => {
                  setPreviewLoading(false);
                  setPreviewPlaying(false);
                }}
                onWaiting={() => setPreviewLoading(true)}
                onError={() => {
                  setPreviewLoading(false);
                  setPreviewPlaying(false);
                  setPreviewProblem(
                    'This generated cue could not be loaded from the local cache. Run it again to replace the missing audio.',
                  );
                }}
              />

              <section className="defaults-bar" aria-label="Script defaults">
                <div className="defaults-bar__heading">
                  <p className="step-label">Script defaults</p>
                  <span>Inherited by every cue unless it shows an override.</span>
                </div>
                <label className="field">
                  <span>Voice</span>
                  <select
                    aria-label="Script default voice"
                    value={defaults.voiceId ?? ''}
                    onChange={(event) => {
                      const voice = props.voices.find((candidate) => candidate.id === event.target.value);
                      props.onUpdateDefaults({
                        voiceId: voice?.id ?? null,
                        voiceName: voice?.name ?? null,
                      });
                    }}
                  >
                    <option value="">Described voice</option>
                    {props.voices.map((voice) => <option key={voice.id} value={voice.id} disabled={!voice.available}>{voice.name}</option>)}
                  </select>
                </label>
                <label className="field defaults-bar__instruction">
                  <span>Delivery instruction</span>
                  <input type="text" aria-label="Script default delivery instruction" value={defaults.instruction} onChange={(event) => props.onUpdateDefaults({ instruction: event.target.value })} />
                </label>
                <label className="field field--compact">
                  <span>CFG</span>
                  <input type="number" min="0.1" step="0.1" aria-label="Script default CFG" value={defaults.cfgScale} onChange={(event) => props.onUpdateDefaults({ cfgScale: Number(event.target.value) })} />
                </label>
                <label className="field field--compact">
                  <span>Seed</span>
                  <input type="number" aria-label="Script default seed" value={defaults.seed} onChange={(event) => props.onUpdateDefaults({ seed: Number(event.target.value) })} />
                </label>
                <label className="field field--compact">
                  <span>Seed behavior</span>
                  <select aria-label="Script seed behavior" value={defaults.seedMode} onChange={(event) => props.onUpdateDefaults({ seedMode: event.target.value === 'increment' ? 'increment' : 'fixed' })}>
                    <option value="fixed">Same seed</option>
                    <option value="increment">Increment per cue</option>
                  </select>
                </label>
              </section>

              <div className="cue-list" role="list" aria-label="Script cues">
                {props.script.cues.map((cue) => (
                  <ScriptCue
                    key={cue.id}
                    cue={cue}
                    script={props.script!}
                    voices={props.voices}
                    onEdit={(patch) => props.onEditCue(cue.id, patch)}
                    previewing={previewCue?.id === cue.id}
                    previewPlaying={previewCue?.id === cue.id && previewPlaying}
                    previewLoading={previewCue?.id === cue.id && previewLoading}
                    onPreview={() => preview(cue)}
                  />
                ))}
              </div>

              <div className="script-actions">
                <button type="button" className="primary-action" disabled={props.running} onClick={props.onRun}>{props.running ? 'Running stale cues…' : 'Run stale cues'}</button>
                <button type="button" className="secondary-action" disabled={props.running} onClick={() => props.onExport('vtt')}>Export VTT</button>
                <button type="button" className="secondary-action" disabled={props.running} onClick={() => props.onExport('wav')}>Export WAV</button>
                <p>Only stale or failed cues reach the GPU. Cached lines stay untouched.</p>
              </div>
            </>
          )}
          {props.problem && <p className="inline-problem" role="status">{props.problem}</p>}
        </div>
      </div>
    </section>
  );
}

function ScriptCue(props: {
  readonly cue: Cue;
  readonly script: Script;
  readonly voices: readonly Voice[];
  readonly onEdit: (patch: CuePatch) => void;
  readonly previewing: boolean;
  readonly previewPlaying: boolean;
  readonly previewLoading: boolean;
  readonly onPreview: () => void;
}): JSX.Element {
  const { cue } = props;
  const effective = effectiveCueSettings(props.script, cue);
  const target = targetSeconds(cue);
  const inheritedVoice = props.script.defaults?.voiceName ?? 'described voice';
  return (
    <article className="cue-row" role="listitem">
      <div className="cue-row__index">{String(cue.index + 1).padStart(2, '0')}</div>
      <div className="cue-row__body">
        <label className="field cue-row__text">
          <span>Line {cue.index + 1}</span>
          <textarea aria-label={`Cue ${cue.index + 1} text`} value={cue.text} onChange={(event) => props.onEdit({ text: event.target.value })} />
        </label>
        <div className="cue-overrides">
          <label className="field">
            <span>Voice {cue.overrides?.voiceId ? <em>Override</em> : <small>Inherited · {inheritedVoice}</small>}</span>
            <select
              aria-label={`Cue ${cue.index + 1} voice override`}
              value={cue.overrides?.voiceId ?? ''}
              onChange={(event) => {
                const voice = props.voices.find((candidate) => candidate.id === event.target.value);
                props.onEdit({ overrides: { voiceId: voice?.id ?? null, voiceName: voice?.name ?? null } });
              }}
            >
              <option value="">Inherit — {inheritedVoice}</option>
              {props.voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
            </select>
          </label>
          <label className="field cue-overrides__instruction">
            <span>Delivery {cue.overrides?.instruction ? <em>Override</em> : <small>Inherited</small>}</span>
            <input
              type="text"
              aria-label={`Cue ${cue.index + 1} delivery override`}
              value={cue.overrides?.instruction ?? ''}
              placeholder={`Inherit — ${props.script.defaults?.instruction ?? INITIAL_SCRIPT_DEFAULTS.instruction}`}
              onChange={(event) => props.onEdit(overridePatch('instruction', event.target.value || null))}
            />
          </label>
          <label className="field field--compact">
            <span>CFG {cue.overrides?.cfgScale !== null && cue.overrides?.cfgScale !== undefined ? <em>Override</em> : <small>Inherited</small>}</span>
            <input type="number" min="0.1" step="0.1" aria-label={`Cue ${cue.index + 1} CFG override`} value={cue.overrides?.cfgScale ?? ''} placeholder={String(effective.cfgScale)} onChange={(event) => props.onEdit(overridePatch('cfgScale', event.target.value ? Number(event.target.value) : null))} />
          </label>
          <label className="field field--compact">
            <span>Seed {cue.overrides?.seed !== null && cue.overrides?.seed !== undefined ? <em>Override</em> : <small>Inherited</small>}</span>
            <input type="number" aria-label={`Cue ${cue.index + 1} seed override`} value={cue.overrides?.seed ?? ''} placeholder={String(effective.seed)} onChange={(event) => props.onEdit(overridePatch('seed', event.target.value ? Number(event.target.value) : null))} />
          </label>
        </div>
        <div className="cue-row__meta">
          <button
            type="button"
            className="chip cue-row__preview"
            disabled={cue.state !== 'done'}
            aria-label={`${props.previewPlaying ? 'Pause' : 'Preview'} cue ${cue.index + 1}`}
            aria-pressed={props.previewing}
            title={cue.state === 'done' ? undefined : 'Preview is available after this cue is generated.'}
            onClick={props.onPreview}
          >
            {props.previewLoading
              ? 'Loading…'
              : props.previewPlaying
                ? 'Pause preview'
                : 'Preview'}
          </button>
          <span className={`cue-state cue-state--${cue.state}`}>{CUE_STATE_LABEL[cue.state]}</span>
          <span>Target {formatTarget(target)}</span>
          <span>Actual {cue.actualSeconds === null ? '—' : `${cue.actualSeconds.toFixed(1)}s`}</span>
          <span>Drift {driftLabel(cue)}</span>
          <span>CFG {effective.cfgScale}</span>
          <span>Seed {effective.seed}</span>
        </div>
        {cue.problem && <p className="inline-problem" role="status" aria-label={`Cue ${cue.index + 1} problem`}>{cue.problem}</p>}
      </div>
    </article>
  );
}
