/** Test setup: jest-dom matchers, plus the browser APIs jsdom does not ship. */
import '@testing-library/jest-dom/vitest';

// jsdom has no object URLs and no media element playback. Neither is under
// test here — the playback path is exercised through an injected backend — so
// they are stubbed rather than emulated.
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
}
if (typeof globalThis.HTMLMediaElement !== 'undefined') {
  globalThis.HTMLMediaElement.prototype.play = async function play(): Promise<void> {};
  globalThis.HTMLMediaElement.prototype.pause = function pause(): void {};
}

if (typeof globalThis.HTMLCanvasElement !== 'undefined') {
  globalThis.HTMLCanvasElement.prototype.getContext = (() => {
    return {
      clearRect: () => {},
      fillRect: () => {},
      fillStyle: '',
      setTransform: () => {},
    } as unknown as CanvasRenderingContext2D;
  }) as unknown as typeof globalThis.HTMLCanvasElement.prototype.getContext;
}

// jsdom's File does not implement `text()`. The component relies on it, and a
// real browser provides it, so it is filled in here rather than worked around
// in the component.
if (typeof File !== 'undefined' && typeof File.prototype.text !== 'function') {
  File.prototype.text = function text(this: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}
