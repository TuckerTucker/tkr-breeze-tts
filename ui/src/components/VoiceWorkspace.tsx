/** Voices workspace: create, audition, keep, rename, and reuse voices. */

import { useState, type JSX } from 'react';

import { CfgControl } from './CfgControl.js';
import { ReferenceCapture } from './ReferenceCapture.js';
import { originLine, type PendingUndo, type Voice } from '../state/voices.js';
import type { Clip } from '../state/history.js';
import type { CfgControl as CfgControlShape } from '../state/mode.js';
import type { StagedReferenceSelection } from '../state/reference.js';
import { suggestName } from '../state/name.js';

/** Local creation language inside Voices, never an application mode. */
export type VoiceCreationMethod = 'describe' | 'clone-audio' | 'from-clip';

/** Draft retained while the operator navigates to another tool. */
export interface VoiceCreationDraft {
  readonly method: VoiceCreationMethod;
  readonly name: string;
  readonly description: string;
  readonly sampleText: string;
  readonly cfgScale: number;
  readonly seed: number;
  readonly reference: StagedReferenceSelection | null;
  readonly sourceClipId: string | null;
  readonly auditionClipId: string | null;
}

/** Starting voice-creation values. */
export const INITIAL_VOICE_CREATION_DRAFT: VoiceCreationDraft = {
  method: 'describe',
  name: 'Untitled voice',
  description: 'A warm, clear narrator with an unhurried pace.',
  sampleText: 'This is how this voice will sound when you use it.',
  cfgScale: 4,
  seed: 42,
  reference: null,
  sourceClipId: null,
  auditionClipId: null,
};

/** Props composing creation and durable library management. */
export interface VoiceWorkspaceProps {
  readonly voices: readonly Voice[];
  readonly clips: readonly Clip[];
  readonly draft: VoiceCreationDraft;
  readonly onDraftChange: (draft: VoiceCreationDraft) => void;
  readonly cfgControl: CfgControlShape;
  readonly cfgUnmeasured: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly pendingUndo: PendingUndo | null;
  readonly onAudition: () => void;
  readonly onSave: () => void;
  readonly onRename: (voice: Voice, name: string) => void;
  readonly onDelete: (voice: Voice) => void;
  readonly onUndo: (undo: PendingUndo) => void;
  readonly onUseInSpeak: (voice: Voice) => void;
  readonly onUseInScript: (voice: Voice) => void;
  readonly scriptsAvailable: boolean;
  readonly voiceAudioUrl: (id: string) => string;
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

/**
 * Render the complete Create → Keep → Use voice lifecycle.
 *
 * @param props - Shared library data, creation draft, and injected actions.
 * @returns The Voices tool.
 */
export function VoiceWorkspace(props: VoiceWorkspaceProps): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const setDraft = (patch: Partial<VoiceCreationDraft>): void =>
    props.onDraftChange({ ...props.draft, ...patch });
  const selectedSourceClip = props.draft.sourceClipId
    ? props.clips.find((clip) => clip.id === props.draft.sourceClipId) ?? null
    : null;

  return (
    <section
      id="workspace-panel-voices"
      role="tabpanel"
      aria-labelledby="workspace-tab-voices"
      className="workspace"
    >
      <div className="workspace__heading">
        <div>
          <p className="eyebrow">Create · Keep · Reuse</p>
          <h2>Voices</h2>
          <p>Build a reusable voice once, then carry it into speech whenever you need it.</p>
        </div>
      </div>

      <section className="tool-card tool-card--accent" aria-label="Create voice">
        <div className="tool-card__heading">
          <div>
            <p className="step-label">New voice</p>
            <h3>Choose how to begin</h3>
          </div>
          {props.draft.auditionClipId && <span className="status-mark">Audition ready</span>}
        </div>

        <div className="segmented" role="group" aria-label="Voice creation method">
          {([
            ['describe', 'Describe'],
            ['clone-audio', 'Clone audio'],
            ['from-clip', 'Create from clip'],
          ] as const).map(([method, label]) => (
            <button
              key={method}
              type="button"
              aria-pressed={props.draft.method === method}
              onClick={() => setDraft({ method, auditionClipId: null })}
            >
              {label}
            </button>
          ))}
        </div>

        {props.draft.method === 'describe' && (
          <div className="form-grid">
            <label className="field field--wide">
              <span>Voice description</span>
              <textarea
                aria-label="Voice description"
                value={props.draft.description}
                onChange={(event) => setDraft({ description: event.target.value, auditionClipId: null })}
              />
            </label>
            <label className="field field--wide">
              <span>Audition line</span>
              <input
                type="text"
                aria-label="Voice audition line"
                value={props.draft.sampleText}
                onChange={(event) => setDraft({ sampleText: event.target.value, auditionClipId: null })}
              />
            </label>
          </div>
        )}

        {props.draft.method === 'clone-audio' && (
          <div className="creation-section">
            <p className="section-copy">
              Upload once, then move one measured selection. Its transcript follows the audio.
            </p>
            <ReferenceCapture
              selection={props.draft.reference}
              onSelectionChange={(reference) => setDraft({ reference, auditionClipId: null })}
              onStage={props.onStage}
              disabled={props.busy}
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
            <label className="field">
              <span>Default delivery</span>
              <input
                type="text"
                aria-label="Cloned voice default delivery"
                value={props.draft.description}
                onChange={(event) => setDraft({ description: event.target.value, auditionClipId: null })}
              />
            </label>
            <label className="field">
              <span>Audition line</span>
              <input
                type="text"
                aria-label="Voice audition line"
                value={props.draft.sampleText}
                onChange={(event) => setDraft({ sampleText: event.target.value, auditionClipId: null })}
              />
            </label>
          </div>
        )}

        {props.draft.method === 'from-clip' && (
          <label className="field">
            <span>Generated clip</span>
            <select
              aria-label="Generated clip"
              value={props.draft.sourceClipId ?? ''}
              onChange={(event) => {
                const sourceClipId = event.target.value || null;
                const sourceClip = props.clips.find((clip) => clip.id === sourceClipId);
                setDraft({
                  sourceClipId,
                  ...(
                    sourceClip && props.draft.name === INITIAL_VOICE_CREATION_DRAFT.name
                      ? { name: suggestName(sourceClip.request.instruction) }
                      : {}
                  ),
                });
              }}
            >
              <option value="">Choose a recent clip</option>
              {props.clips.map((clip) => (
                <option key={clip.id} value={clip.id}>
                  {clip.request.text.slice(0, 72)}
                </option>
              ))}
            </select>
            {props.clips.length === 0 && <small>Generate a clip in Speak first.</small>}
            {props.draft.sourceClipId && !selectedSourceClip && (
              <small className="blocked" role="status">
                That source clip was evicted. Choose another recent clip.
              </small>
            )}
          </label>
        )}

        {props.draft.method !== 'from-clip' && (
          <div className="advanced-row">
            <CfgControl
              control={props.cfgControl}
              value={props.draft.cfgScale}
              label={props.draft.method === 'describe' ? 'Description strength' : 'Voice balance'}
              unmeasured={props.cfgUnmeasured}
              onChange={(cfgScale) => setDraft({ cfgScale, auditionClipId: null })}
            />
            <label className="field field--compact">
              <span>Seed</span>
              <input
                type="number"
                aria-label="Voice creation seed"
                value={props.draft.seed}
                onChange={(event) => setDraft({ seed: Number(event.target.value) || 0, auditionClipId: null })}
              />
            </label>
          </div>
        )}

        <div className="creation-actions">
          {props.draft.method !== 'from-clip' && (
            <button
              type="button"
              className="secondary-action"
              disabled={props.busy || !props.draft.sampleText.trim()}
              onClick={props.onAudition}
            >
              {props.draft.auditionClipId ? 'Audition again' : 'Audition voice'}
            </button>
          )}
          <label className="field creation-actions__name">
            <span>Voice name</span>
            <input
              type="text"
              aria-label="New voice name"
              value={props.draft.name}
              onChange={(event) => setDraft({ name: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="primary-action"
            disabled={
              props.busy ||
              !props.draft.name.trim() ||
              (props.draft.method === 'from-clip'
                ? !selectedSourceClip
                : !props.draft.auditionClipId)
            }
            onClick={props.onSave}
          >
            Keep voice
          </button>
        </div>
        {props.problem && <p className="inline-problem" role="status">{props.problem}</p>}
      </section>

      <section className="library-section" aria-label="Voice library">
        <div className="section-heading">
          <div>
            <p className="step-label">Library</p>
            <h3>{props.voices.length === 0 ? 'No voices kept yet' : `${props.voices.length} kept voice${props.voices.length === 1 ? '' : 's'}`}</h3>
          </div>
          <p>Stored locally with their audio, transcript, provenance, and delivery default.</p>
        </div>

        {props.pendingUndo && (
          <div className="undo-strip" role="status">
            <span>Deleted “{props.pendingUndo.voice.name}”.</span>
            <button type="button" onClick={() => props.onUndo(props.pendingUndo!)}>Undo</button>
          </div>
        )}

        {props.voices.length === 0 ? (
          <div className="empty-state empty-state--static">
            <strong>Create your first voice</strong>
            <span>Describe it, clone a recording, or promote a generated clip.</span>
          </div>
        ) : (
          <div className="voice-grid">
            {props.voices.map((voice) => (
              <article key={voice.id} className="voice-card">
                <div className="voice-card__title">
                  {editingId === voice.id ? (
                    <input
                      type="text"
                      aria-label={`Rename ${voice.name}`}
                      value={name}
                      autoFocus
                      onChange={(event) => setName(event.target.value)}
                      onBlur={() => {
                        props.onRename(voice, name);
                        setEditingId(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          props.onRename(voice, name);
                          setEditingId(null);
                        }
                      }}
                    />
                  ) : <h4>{voice.name}</h4>}
                  <span>{voice.durationSeconds.toFixed(1)}s</span>
                </div>
                <p className="voice-card__origin">{originLine(voice)}</p>
                <p className="voice-card__transcript">“{voice.transcript}”</p>
                {voice.defaultDirection && (
                  <p className="voice-card__default">Default delivery · {voice.defaultDirection}</p>
                )}
                {!voice.available && <p className="inline-problem">Audio unavailable. Save it again.</p>}
                <audio controls preload="none" src={props.voiceAudioUrl(voice.id)} aria-label={`Preview ${voice.name}`} />
                <div className="voice-card__actions">
                  <button type="button" disabled={!voice.available} onClick={() => props.onUseInSpeak(voice)}>Use in Speak</button>
                  {props.scriptsAvailable && (
                    <button type="button" disabled={!voice.available} onClick={() => props.onUseInScript(voice)}>Use in Script</button>
                  )}
                  <button type="button" onClick={() => { setEditingId(voice.id); setName(voice.name); }}>Rename</button>
                  <button type="button" onClick={() => props.onDelete(voice)}>Delete</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
