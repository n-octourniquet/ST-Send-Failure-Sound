/**
 * Send Failure Sound - SillyTavern UI extension
 *
 * Plays a sound when SillyTavern reports an error (the red toast popup), which is
 * how a failed send / failed generation is surfaced: API errors, connection
 * problems, bad keys, timeouts, "could not get a reply", and so on.
 *
 * SillyTavern has no dedicated "generation failed" event (GENERATION_ENDED fires
 * on success *and* on error), so this hooks toastr.error and optionally limits
 * itself to errors that happen around a send/generation.
 */

const MODULE_NAME = 'send_failure_sound';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    volume: 80,            // 0-100, same default loudness as the built-in message sound
    onlyUnfocused: false,  // only play when the tab/window is in the background
    onlyDuringSend: false, // ignore error toasts that aren't near a send/generation
    customUrl: '',         // e.g. /sounds/error.mp3 (a file in public/sounds/)
    customData: '',        // uploaded audio, stored as a data: URL
    customName: '',
});

const COOLDOWN_MS = 1500;                  // don't stack sounds when several toasts fire at once
const GRACE_MS = 5000;                     // errors this soon after a generation ends still count
const SEND_WINDOW_MS = 15 * 1000;          // window opened by sending a message
const MAX_GENERATION_MS = 10 * 60 * 1000;  // safety cap so the "active" state can never get stuck
const MAX_UPLOAD_BYTES = 512 * 1024;

let activeUntil = 0;
let lastPlayedAt = 0;
let audioContext = null;

/* ---------- settings ---------- */

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) settings[key] = DEFAULT_SETTINGS[key];
    }
    return settings;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/* ---------- audio ---------- */

function unlockAudio() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioContext ??= new Ctx();
        if (audioContext.state === 'suspended') audioContext.resume();
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Could not prepare audio:`, err);
    }
}

/** Built-in fallback: two falling notes, generated so no audio file is needed. */
function playBeep(volume) {
    try {
        unlockAudio();
        if (!audioContext) return;
        const start = audioContext.currentTime;
        const peak = Math.max(volume, 0.0001) * 0.6;

        for (const [freq, offset] of [[523.25, 0], [349.23, 0.18]]) {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            const t = start + offset;
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, t);
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.linearRampToValueAtTime(peak, t + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
            osc.connect(gain).connect(audioContext.destination);
            osc.start(t);
            osc.stop(t + 0.32);
        }
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Beep failed:`, err);
    }
}

function playFailureSound({ force = false } = {}) {
    const settings = getSettings();

    if (!force) {
        if (!settings.enabled) return;
        if (settings.onlyUnfocused && document.hasFocus()) return;
        const now = Date.now();
        if (now - lastPlayedAt < COOLDOWN_MS) return;
        lastPlayedAt = now;
    }

    const raw = Number(settings.volume);
    const volume = Number.isFinite(raw) ? Math.min(Math.max(raw / 100, 0), 1) : 0.8;
    const source = settings.customData || String(settings.customUrl || '').trim();

    if (!source) {
        playBeep(volume);
        return;
    }

    try {
        const audio = new Audio(source);
        audio.volume = volume;
        audio.play().catch((err) => {
            console.warn(`[${MODULE_NAME}] Custom sound failed, using built-in beep:`, err);
            playBeep(volume);
        });
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Custom sound failed, using built-in beep:`, err);
        playBeep(volume);
    }
}

/* ---------- failure detection ---------- */

function onErrorToast() {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (settings.onlyDuringSend && Date.now() >= activeUntil) return;
    playFailureSound();
}

function hookToastr() {
    const t = window.toastr;
    if (!t || typeof t.error !== 'function' || t.error.__sfsHooked) return;

    const original = t.error;
    const wrapped = function (...args) {
        try {
            onErrorToast();
        } catch (err) {
            console.warn(`[${MODULE_NAME}] Error handler failed:`, err);
        }
        return original.apply(this, args);
    };
    wrapped.__sfsHooked = true;
    t.error = wrapped;
}

function trackSendWindow() {
    const { eventSource, eventTypes } = SillyTavern.getContext();

    eventSource.on(eventTypes.MESSAGE_SENT, () => {
        activeUntil = Math.max(activeUntil, Date.now() + SEND_WINDOW_MS);
    });
    eventSource.on(eventTypes.GENERATION_STARTED, (type, params, dryRun) => {
        if (dryRun) return;
        activeUntil = Date.now() + MAX_GENERATION_MS;
    });
    // GENERATION_ENDED fires on success and on error alike.
    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        activeUntil = Date.now() + GRACE_MS;
    });
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        activeUntil = Date.now() + GRACE_MS;
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        activeUntil = 0;
    });
}

/* ---------- settings UI ---------- */

function renderSettings() {
    const html = `
    <div id="sfs_settings" class="extension_container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Send Failure Sound</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="sfs_enabled">
                    <input id="sfs_enabled" type="checkbox" />
                    <span>Play a sound when a message fails</span>
                </label>
                <label class="checkbox_label" for="sfs_unfocused">
                    <input id="sfs_unfocused" type="checkbox" />
                    <span>Background sound only (when this tab isn't focused)</span>
                </label>
                <label class="checkbox_label" for="sfs_during_send">
                    <input id="sfs_during_send" type="checkbox" />
                    <span>Only errors during a send/generation (ignore unrelated error popups)</span>
                </label>

                <label for="sfs_volume">Volume: <span id="sfs_volume_value"></span>%</label>
                <input id="sfs_volume" type="range" min="0" max="100" step="1" />

                <label for="sfs_url">Custom sound URL (optional)</label>
                <input id="sfs_url" class="text_pole" type="text" placeholder="/sounds/error.mp3" />

                <div class="flex-container">
                    <label class="menu_button" for="sfs_file">
                        <i class="fa-solid fa-upload"></i> Upload sound
                    </label>
                    <input id="sfs_file" type="file" accept="audio/*" hidden />
                    <div id="sfs_clear" class="menu_button"><i class="fa-solid fa-xmark"></i> Reset to built-in</div>
                    <div id="sfs_test" class="menu_button"><i class="fa-solid fa-play"></i> Test</div>
                </div>
                <small id="sfs_status"></small>
            </div>
        </div>
    </div>`;

    const target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    target.append(html);

    const refreshStatus = () => {
        const s = getSettings();
        let text = 'Using the built-in beep.';
        if (s.customData) text = `Using uploaded file: ${s.customName || 'audio'}`;
        else if (String(s.customUrl || '').trim()) text = 'Using the custom URL above.';
        $('#sfs_status').text(text);
    };

    const s = getSettings();
    $('#sfs_enabled').prop('checked', s.enabled).on('input', function () {
        getSettings().enabled = !!this.checked;
        saveSettings();
    });
    $('#sfs_unfocused').prop('checked', s.onlyUnfocused).on('input', function () {
        getSettings().onlyUnfocused = !!this.checked;
        saveSettings();
    });
    $('#sfs_during_send').prop('checked', s.onlyDuringSend).on('input', function () {
        getSettings().onlyDuringSend = !!this.checked;
        saveSettings();
    });

    $('#sfs_volume').val(s.volume).on('input', function () {
        getSettings().volume = Number(this.value);
        $('#sfs_volume_value').text(this.value);
        saveSettings();
    }).on('change', () => playFailureSound({ force: true }));
    $('#sfs_volume_value').text(s.volume);

    $('#sfs_url').val(s.customUrl).on('input', function () {
        getSettings().customUrl = String(this.value);
        saveSettings();
        refreshStatus();
    });

    $('#sfs_file').on('change', function () {
        const file = this.files && this.files[0];
        this.value = '';
        if (!file) return;
        // warning, not error: an error toast would trigger the failure sound itself
        if (!file.type.startsWith('audio/')) {
            toastr.warning('That file does not look like audio.', 'Send Failure Sound');
            return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            toastr.warning(`Keep uploads under ${MAX_UPLOAD_BYTES / 1024} KB, or use a URL instead.`, 'Send Failure Sound');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const settings = getSettings();
            settings.customData = String(reader.result);
            settings.customName = file.name;
            saveSettings();
            refreshStatus();
            playFailureSound({ force: true });
        };
        reader.readAsDataURL(file);
    });

    $('#sfs_clear').on('click', () => {
        const settings = getSettings();
        settings.customData = '';
        settings.customName = '';
        settings.customUrl = '';
        $('#sfs_url').val('');
        saveSettings();
        refreshStatus();
    });

    $('#sfs_test').on('click', () => playFailureSound({ force: true }));

    refreshStatus();
}

/* ---------- init ---------- */

jQuery(() => {
    getSettings();
    renderSettings();
    trackSendWindow();
    hookToastr();
    for (const evt of ['pointerdown', 'keydown']) {
        document.addEventListener(evt, unlockAudio, { once: true, passive: true });
    }
    console.log(`[${MODULE_NAME}] loaded`);
});
