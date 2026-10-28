import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

/// Delay before the first look at a window, so that the client has drawn its real content.
const FIRST_CHECK_DELAY_MS = 300;
/// A window found opaque is looked at once more, for clients that draw their content late.
const LATE_CHECK_DELAY_MS = 3000;
/// Resizing an opaque window can reveal translucent parts (e.g. a sidebar appearing).
const RESIZE_CHECK_DELAY_MS = 1500;
const MAX_RESIZE_CHECKS = 3;
/// Some themes make windows translucent only while focused (e.g. MacTahoe sidebars).
const FOCUS_CHECK_DELAY_MS = 400;
const MAX_FOCUS_CHECKS = 2;
/// Retries while the window cannot be painted yet (no actor, not mapped...).
const MAX_CAPTURE_RETRIES = 10;
const RETRY_DELAY_MS = 200;

/// A pixel counts as translucent below this alpha.
const ALPHA_THRESHOLD = 250;
/// Share of the sampled pixels that must be translucent for the window to be blurred.
const TRANSLUCENT_RATIO = 0.01;
/// Pixels close to the edges are ignored: rounded corners are transparent in every window.
const EDGE_MARGIN = 24;
/// Roughly how many pixels are sampled per window.
const TARGET_SAMPLES = 40000;

/// Applications found translucent once are remembered (by WM class), so that their next windows
/// are blurred from the first frame instead of after the detection delay.
const KNOWN_APPS_FILE = GLib.build_filenamev(
    [GLib.get_user_cache_dir(), 'blur-my-shell', 'translucent-apps.json']
);

export const Transparency = {
    UNKNOWN: 0,
    OPAQUE: 1,
    TRANSLUCENT: 2,
};

/// Finds out whether a window has translucent parts, by painting it once offscreen and reading
/// its alpha channel. Blurring the background of a fully opaque window costs as much as any other
/// window but is never visible, so this lets the applications component skip them.
export class TransparencyDetector {
    constructor(on_result, log) {
        this._on_result = on_result;
        this._log = log;
        this._records = new Map();
        // captures are done one after the other, to avoid spikes when many windows appear
        this._queue = Promise.resolve();
        this._known_apps = load_known_apps();
    }

    state(meta_window) {
        return this._records.get(meta_window)?.state ?? Transparency.UNKNOWN;
    }

    is_translucent(meta_window) {
        return this.state(meta_window) === Transparency.TRANSLUCENT
            || this._known_apps.has(meta_window.get_wm_class());
    }

    /// Starts looking at a window, if not already done. Idempotent.
    watch(meta_window) {
        if (this._records.has(meta_window))
            return;

        const record = {
            state: Transparency.UNKNOWN,
            timeout_id: 0,
            retries: 0,
            late_check_done: false,
            resize_checks: 0,
            focus_checks: 0,
            signal_ids: [],
        };
        this._records.set(meta_window, record);

        record.signal_ids.push(meta_window.connect('size-changed', () => {
            if (record.state === Transparency.OPAQUE && record.resize_checks < MAX_RESIZE_CHECKS) {
                record.resize_checks++;
                this._schedule(meta_window, record, RESIZE_CHECK_DELAY_MS);
            }
        }));
        record.signal_ids.push(meta_window.connect('notify::appears-focused', () => {
            if (record.state === Transparency.OPAQUE && meta_window.appears_focused
                && record.focus_checks < MAX_FOCUS_CHECKS) {
                record.focus_checks++;
                this._schedule(meta_window, record, FOCUS_CHECK_DELAY_MS);
            }
        }));
        record.signal_ids.push(meta_window.connect('shown', () => {
            if (record.state === Transparency.UNKNOWN && !record.timeout_id) {
                record.retries = 0;
                this._schedule(meta_window, record, FIRST_CHECK_DELAY_MS);
            }
        }));

        this._schedule(meta_window, record, FIRST_CHECK_DELAY_MS);
    }

    forget(meta_window) {
        const record = this._records.get(meta_window);
        if (!record)
            return;

        if (record.timeout_id)
            GLib.source_remove(record.timeout_id);
        record.signal_ids.forEach(id => meta_window.disconnect(id));
        record.destroyed = true;
        this._records.delete(meta_window);
    }

    clear() {
        [...this._records.keys()].forEach(meta_window => this.forget(meta_window));
    }

    _remember(wm_class) {
        if (!wm_class || this._known_apps.has(wm_class))
            return;

        this._known_apps.add(wm_class);
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(KNOWN_APPS_FILE), 0o755);
            GLib.file_set_contents(KNOWN_APPS_FILE, JSON.stringify([...this._known_apps]));
        } catch (e) {
            this._log(`could not save the translucent applications: ${e}`);
        }
    }

    _schedule(meta_window, record, delay) {
        if (record.timeout_id)
            GLib.source_remove(record.timeout_id);

        record.timeout_id = GLib.timeout_add(GLib.PRIORITY_LOW, delay, () => {
            record.timeout_id = 0;
            this._queue = this._queue
                .then(() => this._check(meta_window, record))
                .catch(e => this._log(`transparency check failed: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _check(meta_window, record) {
        // remembered applications are blurred right away, no need to look at them
        if (record.destroyed || record.state === Transparency.TRANSLUCENT
            || this._known_apps.has(meta_window.get_wm_class()))
            return;

        const result = await this._measure(meta_window);
        if (record.destroyed)
            return;

        if (result === Transparency.UNKNOWN) {
            // not paintable right now: retry a few times, then wait for the window to be shown
            if (record.retries++ < MAX_CAPTURE_RETRIES)
                this._schedule(meta_window, record, RETRY_DELAY_MS);
            return;
        }

        const changed = result !== record.state;
        record.state = result;
        if (result === Transparency.TRANSLUCENT)
            this._remember(meta_window.get_wm_class());
        this._log(`${meta_window.get_wm_class()}: ${result === Transparency.TRANSLUCENT ? 'translucent' : 'opaque'}`);

        if (result === Transparency.OPAQUE && !record.late_check_done) {
            record.late_check_done = true;
            this._schedule(meta_window, record, LATE_CHECK_DELAY_MS);
        }

        if (changed)
            this._on_result(meta_window);
    }

    /// Paints the visible part of the window (without its shadows) and samples its alpha channel.
    async _measure(meta_window) {
        const window_actor = meta_window.get_compositor_private();
        if (!window_actor || !window_actor.mapped || meta_window.minimized)
            return Transparency.UNKNOWN;
        // the window is being animated (opening, minimizing...): its alpha is not its own
        if (window_actor.opacity !== 255 || window_actor.scale_x !== 1 || window_actor.scale_y !== 1)
            return Transparency.UNKNOWN;
        if (window_actor.width < 1 || window_actor.height < 1)
            return Transparency.UNKNOWN;

        const frame = meta_window.get_frame_rect();
        const buffer = meta_window.get_buffer_rect();
        if (frame.width <= 2 * EDGE_MARGIN || frame.height <= 2 * EDGE_MARGIN)
            return Transparency.UNKNOWN;

        // the clip argument of paint_to_content is not reliable across window types, so the whole
        // buffer (with shadows) is painted, and only the frame part is analysed
        const content = window_actor.paint_to_content(null);
        const texture = content?.get_texture();
        if (!texture || !buffer.width || !buffer.height)
            return Transparency.UNKNOWN;

        const scale = texture.get_width() / buffer.width;
        const frame_in_texture = {
            x: Math.round((frame.x - buffer.x) * scale),
            y: Math.round((frame.y - buffer.y) * scale),
            width: Math.round(frame.width * scale),
            height: Math.round(frame.height * scale),
            margin: Math.round(EDGE_MARGIN * scale),
        };

        const stream = Gio.MemoryOutputStream.new_resizable();
        const pixbuf = await new Promise((resolve, reject) => {
            Shell.Screenshot.composite_to_stream(
                texture, 0, 0, -1, -1, 1, null, 0, 0, 1, stream,
                (_, res) => {
                    try {
                        resolve(Shell.Screenshot.composite_to_stream_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
        stream.close(null);

        if (!pixbuf)
            return Transparency.UNKNOWN;
        if (!pixbuf.get_has_alpha())
            return Transparency.OPAQUE;

        return sample_alpha(pixbuf, frame_in_texture) ? Transparency.TRANSLUCENT : Transparency.OPAQUE;
    }
}

function load_known_apps() {
    try {
        const [, contents] = GLib.file_get_contents(KNOWN_APPS_FILE);
        const list = JSON.parse(new TextDecoder().decode(contents));
        if (Array.isArray(list))
            return new Set(list.filter(item => typeof item === 'string'));
    } catch (_) {
        // no file yet, or unreadable: start from scratch
    }
    return new Set();
}

/// Returns whether enough sampled pixels of the frame area of the pixbuf are translucent.
function sample_alpha(pixbuf, frame) {
    const rowstride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const pixels = pixbuf.get_pixels();

    const x0 = Math.max(0, frame.x + frame.margin);
    const y0 = Math.max(0, frame.y + frame.margin);
    const x1 = Math.min(pixbuf.get_width(), frame.x + frame.width - frame.margin);
    const y1 = Math.min(pixbuf.get_height(), frame.y + frame.height - frame.margin);
    if (x1 <= x0 || y1 <= y0)
        return false;

    const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / TARGET_SAMPLES)));

    let total = 0, translucent = 0;
    for (let y = y0; y < y1; y += step) {
        const row = y * rowstride;
        for (let x = x0; x < x1; x += step) {
            total++;
            if (pixels[row + x * channels + 3] < ALPHA_THRESHOLD)
                translucent++;
        }
    }

    return total > 0 && translucent / total >= TRANSLUCENT_RATIO;
}
