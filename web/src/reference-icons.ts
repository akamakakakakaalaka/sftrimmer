import gear from './icons/gear.svg?url';
import music from './icons/beamed-notes.svg?url';

const fallback = {gear, music};

/** Native system glyphs on iOS; our own offline SVGs on other platforms. */
export function referenceIcon(name: keyof typeof fallback): string {
  const native = (window as Window & {project128NativeIcons?: Record<string, unknown>}).project128NativeIcons?.[name];
  // Only the small PNG masks produced by UIKit are accepted from this boundary.
  const nativePNG = typeof native === 'string' && native.length < 40_000
    && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(native);
  const url = (nativePNG ? native : fallback[name]).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<span class="icon reference-icon" data-icon="${name}" data-icon-source="${nativePNG ? 'ios-system' : 'authored-svg'}" aria-hidden="true" style="--reference-glyph:url(&quot;${url}&quot;)"></span>`;
}
