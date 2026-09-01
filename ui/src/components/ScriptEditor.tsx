/**
 * The script editor: the cue list as the document.
 *
 * Editing one line marks only that line stale; everything else replays from
 * cache. That is the whole feature — correcting a line in a forty-line script
 * costs one GPU request rather than forty, which is the difference between a
 * script tool that is usable and one that is not.
 *
 * @module
 */

import { useState, type DragEvent, type JSX } from 'react';

import { CueRow } from './CueRow.js';
import { progressOf, type Cue, type Script } from '../state/script.js';
import type { Voice } from '../state/voices.js';

/** What the editor needs. */
export interface ScriptEditorProps {
  readonly script: Script | null;
  readonly voices: readonly Voice[];
  readonly onImport: (source: string, filename: string) => void;
  readonly onEditCue: (cueId: string, patch: Partial<Cue>) => void;
  readonly onRun: () => void;
  readonly running: boolean;
  readonly exportUrls: { vtt: string; wav: string } | null;
}

/**
 * Render the script editor.
 *
 * @param props - The script and its handlers.
 * @returns The editor element.
 */
export function ScriptEditor(props: ScriptEditorProps): JSX.Element {
  const [dragOver, setDragOver] = useState(false);
  const availableVoiceIds = new Set(props.voices.map((voice) => voice.id));

  const onDrop = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    props.onImport(await file.text(), file.name);
  };

  if (!props.script) {
    return (
      <section className="panel" aria-label="Script">
        <p className="caption caption--ink">Script</p>
        <div
          className={`dropzone${dragOver ? ' dropzone--over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <p className="caption caption--ink">Drop a WebVTT or plain-text file</p>
          <p className="caption">
            Timed cues keep their targets; plain text becomes untimed rows with no
            invented timings.
          </p>
          <label className="chip" style={{ display: 'inline-block', marginTop: 8 }}>
            Choose a file
            <input
              type="file"
              accept=".vtt,.txt,text/plain,text/vtt"
              aria-label="Import a script file"
              style={{ display: 'none' }}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) props.onImport(await file.text(), file.name);
              }}
            />
          </label>
        </div>
      </section>
    );
  }

  const progress = progressOf(props.script);

  return (
    <section className="panel" aria-label="Script">
      <div className="row row--between">
        <div>
          <p className="caption caption--ink">
            Script — imported from {props.script.source === 'vtt' ? 'WebVTT' : 'plain text'}
          </p>
          <p className="caption">
            {props.script.name} / {progress.total} cues
          </p>
        </div>
        <p className="caption" role="status" aria-label="Script progress">
          {progress.done} of {progress.total} done
          {progress.failed > 0 ? ` / ${progress.failed} need attention` : ''}
        </p>
      </div>

      {props.script.problems.length > 0 && (
        <div className="panel--inset" style={{ marginBottom: 16 }}>
          <p className="caption caption--accent">
            {props.script.problems.length} block(s) could not be read and were skipped
          </p>
          {props.script.problems.map((problem) => (
            <p key={problem.block} className="caption">
              Block {problem.block + 1}: {problem.reason}
            </p>
          ))}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table className="cue-table">
          <thead>
            <tr>
              <th scope="col">Cue</th>
              <th scope="col">Line</th>
              <th scope="col">Voice</th>
              <th scope="col">Target</th>
              <th scope="col">Actual</th>
              <th scope="col">Drift</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {props.script.cues.map((cue) => (
              <CueRow
                key={cue.id}
                cue={cue}
                voices={props.voices}
                availableVoiceIds={availableVoiceIds}
                onEdit={(patch) => props.onEditCue(cue.id, patch)}
                onReroll={() =>
                  props.onEditCue(cue.id, { seed: Math.floor(Math.random() * 100_000) })
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="generate"
          style={{ width: 'auto' }}
          disabled={props.running}
          onClick={props.onRun}
        >
          {props.running ? 'Running…' : 'Run script →'}
        </button>
        {props.exportUrls && (
          <>
            <a className="chip" href={props.exportUrls.vtt} download>
              Export VTT
            </a>
            <a className="chip" href={props.exportUrls.wav} download>
              Export WAV
            </a>
          </>
        )}
      </div>
      <p className="caption" style={{ marginTop: 8 }}>
        {progress.stale} stale / {progress.cached} served from cache. Only stale
        cues rerun — editing one line costs one request. Exported timings are the
        durations actually generated, never the imported targets.
      </p>
    </section>
  );
}
