/** Speak workspace: choose a voice, write one line, give one delivery, generate. */

import type { JSX, ReactNode } from 'react';

import { Console } from './Console.js';
import { History } from './History.js';
import { ReferenceCapture } from './ReferenceCapture.js';
import type { Clip } from '../state/history.js';
import type { StagedReferenceSelection } from '../state/reference.js';
import type { Voice } from '../state/voices.js';
import type {
  SpeakDraft,
  SpeakVoiceSource,
  SpeakVoiceSourceAvailability,
} from '../state/workspace.js';

/**
 * What this viewer is waiting on when the demo is busy with someone else.
 *
 * The vendor holds a process-wide lock and answers every contended request with
 * the same 409, so nothing in the error says whose generation is in the way.
 * The shell draws that distinction from whether it has a request in flight —
 * the only place that knows — and hands the answer down as this.
 */
export interface SharedGenerationWait {
  /** Which retry of the held request is pending, counting from one. */
  readonly attempt: number;
  /** How many retries there will ever be. Finite, and stated. */
  readonly attempts: number;
  /** True once they ran out. The composed request is still on screen. */
  readonly exhausted: boolean;
}

/** Props for the one-off speech tool. */
export interface SpeakWorkspaceProps {
  readonly draft: SpeakDraft;
  readonly onDraftChange: (draft: SpeakDraft) => void;
  readonly voices: readonly Voice[];
  readonly blockedReason: string | null;
  readonly statusLine: string;
  readonly onGenerate: () => void;
  readonly generating: boolean;
  /** Set only while someone else's generation is holding this one up. */
  readonly sharedWait?: SharedGenerationWait | null;
  /** Drop the held request and stop retrying. Nothing composed is discarded. */
  readonly onCancelSharedWait?: () => void;
  /**
   * Hand back staged reference audio the draft no longer holds. Optional for
   * the same reason it is on ReferenceCapture: a caller without a gateway
   * client still renders the surface.
   */
  readonly onReleaseReference?: (referenceId: string) => void | Promise<unknown>;
  readonly clips: readonly Clip[];
  readonly selectedClipId: string | null;
  readonly onSelectClip: (clip: Clip) => void;
  readonly onReplay: (clip: Clip) => void;
  readonly onLoadVariation: (clip: Clip) => void;
  readonly onCreateVoiceFromClip: (clip: Clip) => void;
  readonly onSaveVoice: (clip: Clip) => void;
  readonly clipUrl: (id: string) => string;
  readonly historyReadOnlyReason: string | null;
  readonly playbackReadout: ReactNode;
  readonly sourceAvailability: SpeakVoiceSourceAvailability;
  readonly onStage: (
    file: File,
    source: 'upload' | 'record',
  ) => Promise<StagedReferenceSelection>;
  readonly canRecord: boolean;
  readonly recordDisabledReason: string | null;
  readonly referenceMaxSeconds: number;
  readonly referenceMaxMeasured: boolean;
  readonly referenceBranchLimits: { readonly noCfg: number; readonly singleCfg: number } | null;
  readonly referenceTokenCeiling: number;
  readonly referenceAudioUrl: (id: string, start: number, end: number) => string;
  readonly asrRemedy: string | null;
}

function sourceKind(source: SpeakVoiceSource): 'described' | 'saved' | 'staged' {
  return source.kind;
}

const VOICE_SOURCES = [
  { kind: 'described', label: 'Describe' },
  { kind: 'saved', label: 'Saved voice' },
  { kind: 'staged', label: 'Temporary reference' },
] as const;

/**
 * Render a single authoritative voice-plus-delivery request and its recent output.
 *
 * @param props - Canonical Speak state and injected lifecycle actions.
 * @returns The Speak tool.
 */
export function SpeakWorkspace(props: SpeakWorkspaceProps): JSX.Element {
  const legacyMode = props.draft.voice.kind === 'described' ? 'design' : 'clone';
  const source = sourceKind(props.draft.voice);
  const availableSources = VOICE_SOURCES.filter(
    ({ kind }) => props.sourceAvailability[kind],
  );
  const savedVoiceOnly =
    availableSources.length === 1 && availableSources[0]?.kind === 'saved';
  const updateVoice = (voice: SpeakVoiceSource): void =>
    props.onDraftChange({ ...props.draft, voice });

  return (
    <section
      id="workspace-panel-speak"
      role="tabpanel"
      aria-labelledby="workspace-tab-speak"
      className="workspace"
    >
      <div className="workspace__heading">
        <div>
          <p className="eyebrow">Choose · Direct · Listen</p>
          <h2>Speak</h2>
          <p>One voice, one line, and one delivery instruction—the value you see is the value sent.</p>
        </div>
      </div>

      <div className="speak-layout">
        <div className="speak-layout__form">
          <section className="tool-card" aria-label="Voice source">
            <div className="decision-heading">
              <span className="decision-number">01</span>
              <div>
                <h3>Choose a voice</h3>
                <p>
                  {savedVoiceOnly
                    ? 'Choose one of your kept voices.'
                    : 'Choose an available voice source.'}
                </p>
              </div>
            </div>
            {availableSources.length > 1 && (
              <div className="segmented" role="group" aria-label="Speak voice source">
                {availableSources.map(({ kind, label }) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={source === kind}
                    onClick={() => {
                      if (kind === 'described') updateVoice({ kind: 'described' });
                      else if (kind === 'staged') updateVoice({ kind: 'staged', reference: null });
                      else {
                        const first = props.voices.find((voice) => voice.available);
                        updateVoice(
                          first
                            ? { kind: 'saved', voiceId: first.id, voiceName: first.name }
                            : { kind: 'saved', voiceId: '', voiceName: 'No saved voice selected' },
                        );
                      }
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {props.draft.voice.kind === 'saved' && (
              <label className="field">
                <span>Saved voice</span>
                <select
                  aria-label="Saved voice"
                  value={props.draft.voice.voiceId}
                  onChange={(event) => {
                    const voice = props.voices.find((candidate) => candidate.id === event.target.value);
                    if (voice) updateVoice({ kind: 'saved', voiceId: voice.id, voiceName: voice.name });
                  }}
                >
                  <option value="">Choose a voice</option>
                  {props.voices.map((voice) => (
                    <option key={voice.id} value={voice.id} disabled={!voice.available}>
                      {voice.name}{voice.available ? '' : ' — unavailable'}
                    </option>
                  ))}
                </select>
                {props.voices.length === 0 && <small>Create or keep a voice in Voices first.</small>}
              </label>
            )}

            {props.sourceAvailability.staged && props.draft.voice.kind === 'staged' && (
              <ReferenceCapture
                selection={props.draft.voice.reference}
                onSelectionChange={(reference) => updateVoice({ kind: 'staged', reference })}
                onStage={props.onStage}
                onReleaseReference={props.onReleaseReference}
                disabled={props.generating}
                canRecord={props.canRecord}
                recordDisabledReason={props.recordDisabledReason}
                maxSeconds={props.referenceMaxSeconds}
                maxMeasured={props.referenceMaxMeasured}
                cfgScale={props.draft.cfgScale}
                branchLimits={props.referenceBranchLimits}
                tokenCeiling={props.referenceTokenCeiling}
                audioUrl={props.referenceAudioUrl}
                asrRemedy={props.asrRemedy}
              />
            )}
          </section>

          <div className="decision-heading decision-heading--standalone">
            <span className="decision-number">02</span>
            <div><h3>Write and direct</h3><p>Delivery is the only instruction. No hidden field can override it.</p></div>
          </div>
          <Console
            draft={props.draft}
            onDraftChange={(draft) => props.onDraftChange({ ...props.draft, ...draft })}
            blockedReason={props.blockedReason}
            onGenerate={props.onGenerate}
            statusLine={props.statusLine}
            seedControlsVisible={false}
            cfgScale={props.draft.cfgScale}
            mode={legacyMode}
          />
          {/*
            Not an error and not a spinner: a disabled control with its reason
            beside it, which is what a busy state already is here. While the
            wait is live the reason sits on the Console's own status line and
            this strip carries only the way out, so the same sentence is never
            said twice. Once the attempts are spent the Console goes back to
            normal — Generate works again — and the strip is the only thing that
            still has something to say.
          */}
          {props.sharedWait && (
            <div className="undo-strip" role="status">
              {props.sharedWait.exhausted ? (
                <span>
                  The demo stayed busy through {props.sharedWait.attempts} attempts. Your
                  line and settings are exactly as you left them — press Generate to try
                  again.
                </span>
              ) : (
                <>
                  <span>Nothing is lost while this waits.</span>
                  {props.onCancelSharedWait && (
                    <button type="button" onClick={props.onCancelSharedWait}>
                      Stop waiting
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {props.playbackReadout}
        </div>

        <aside className="speak-layout__history">
          <div className="sticky-section">
            <History
              clips={props.clips}
              selectedId={props.selectedClipId}
              clipUrl={props.clipUrl}
              readOnlyReason={props.historyReadOnlyReason}
              onSelect={props.onSelectClip}
              onReplay={props.onReplay}
              onLoadIntoConsole={props.onLoadVariation}
              onPromoteToReference={props.onCreateVoiceFromClip}
              onSaveAsVoice={props.onSaveVoice}
            />
          </div>
        </aside>
      </div>
    </section>
  );
}
