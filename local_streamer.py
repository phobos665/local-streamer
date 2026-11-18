"""
Local Streamer - a minimal OBS-like viewer for HDMI capture cards.

Shows a capture device (e.g. Elgato 4K S) in a window and plays its audio,
so the window can be screen-shared to Discord (window share includes app audio).

Hotkeys (global, work even when the window isn't focused; configurable via menu):
    Ctrl+Alt+Up     volume up
    Ctrl+Alt+Down   volume down
    Ctrl+Alt+M      mute / unmute
Window-only keys:
    F11 / double-click   fullscreen
    Esc                  leave fullscreen
    Right-click          full menu (also works when the menu bar is hidden)
    Ctrl+H               hide / show menu bar
"""

import ctypes
import sys
from ctypes import wintypes

from PySide6.QtCore import QSettings, Qt, QTimer
from PySide6.QtGui import QAction, QActionGroup, QKeySequence
from PySide6.QtMultimedia import (
    QAudioInput,
    QAudioOutput,
    QCamera,
    QMediaCaptureSession,
    QMediaDevices,
)
from PySide6.QtMultimediaWidgets import QVideoWidget
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QKeySequenceEdit,
    QLabel,
    QMainWindow,
    QMenu,
    QMessageBox,
    QSlider,
    QWidgetAction,
)

APP_NAME = "Local Streamer"
PREFERRED_VIDEO = "elgato 4k s"
PREFERRED_AUDIO = "elgato 4k s"
VOLUME_STEP = 5  # percent

DEFAULT_HOTKEYS = {
    "volume_up": "Ctrl+Alt+Up",
    "volume_down": "Ctrl+Alt+Down",
    "mute": "Ctrl+Alt+M",
}
HOTKEY_LABELS = {
    "volume_up": "Volume up",
    "volume_down": "Volume down",
    "mute": "Mute / unmute",
}

# --------------------------------------------------------------------------
# Windows global hotkeys (RegisterHotKey)
# --------------------------------------------------------------------------
WM_HOTKEY = 0x0312
MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, MOD_NOREPEAT = 0x1, 0x2, 0x4, 0x8, 0x4000

_QT_TO_VK = {
    Qt.Key_Up: 0x26, Qt.Key_Down: 0x28, Qt.Key_Left: 0x25, Qt.Key_Right: 0x27,
    Qt.Key_PageUp: 0x21, Qt.Key_PageDown: 0x22, Qt.Key_Home: 0x24, Qt.Key_End: 0x23,
    Qt.Key_Insert: 0x2D, Qt.Key_Delete: 0x2E, Qt.Key_Space: 0x20,
    Qt.Key_Plus: 0xBB, Qt.Key_Equal: 0xBB, Qt.Key_Minus: 0xBD,
    Qt.Key_Comma: 0xBC, Qt.Key_Period: 0xBE, Qt.Key_Slash: 0xBF,
    Qt.Key_BracketLeft: 0xDB, Qt.Key_BracketRight: 0xDD,
    Qt.Key_Pause: 0x13, Qt.Key_ScrollLock: 0x91,
    Qt.Key_VolumeUp: 0xAF, Qt.Key_VolumeDown: 0xAE, Qt.Key_VolumeMute: 0xAD,
}


def _sequence_to_win(seq_text):
    """Convert a Qt key sequence string to (modifiers, vk) for RegisterHotKey."""
    seq = QKeySequence(seq_text)
    if seq.isEmpty():
        return None
    combo = seq[0]
    key = combo.key()
    mods = combo.keyboardModifiers()
    win_mods = MOD_NOREPEAT
    if mods & Qt.ControlModifier:
        win_mods |= MOD_CONTROL
    if mods & Qt.AltModifier:
        win_mods |= MOD_ALT
    if mods & Qt.ShiftModifier:
        win_mods |= MOD_SHIFT
    if mods & Qt.MetaModifier:
        win_mods |= MOD_WIN
    k = int(key.value) if hasattr(key, "value") else int(key)
    if Qt.Key_A.value <= k <= Qt.Key_Z.value or Qt.Key_0.value <= k <= Qt.Key_9.value:
        vk = k  # ASCII matches VK codes
    elif Qt.Key_F1.value <= k <= Qt.Key_F24.value:
        vk = 0x70 + (k - Qt.Key_F1.value)
    else:
        vk = _QT_TO_VK.get(Qt.Key(k))
    if vk is None:
        return None
    return win_mods, vk


class GlobalHotkeys:
    def __init__(self, hwnd):
        self.hwnd = hwnd
        self.user32 = ctypes.windll.user32
        self.ids = {}  # id -> action name

    def register(self, mapping):
        """mapping: action name -> key sequence string. Returns list of failures."""
        self.unregister_all()
        failures = []
        for i, (name, seq) in enumerate(mapping.items(), start=1):
            if not seq:
                continue
            parsed = _sequence_to_win(seq)
            if parsed is None or not self.user32.RegisterHotKey(
                wintypes.HWND(self.hwnd), i, parsed[0], parsed[1]
            ):
                failures.append(f"{HOTKEY_LABELS[name]}: {seq}")
                continue
            self.ids[i] = name
        return failures

    def unregister_all(self):
        for i in self.ids:
            self.user32.UnregisterHotKey(wintypes.HWND(self.hwnd), i)
        self.ids.clear()


# --------------------------------------------------------------------------
# Hotkey settings dialog
# --------------------------------------------------------------------------
class HotkeyDialog(QDialog):
    def __init__(self, current, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Hotkeys")
        layout = QFormLayout(self)
        layout.addRow(QLabel("Global hotkeys (work while the window is in the background).\n"
                             "Click a field and press the new combination."))
        self.edits = {}
        for name, label in HOTKEY_LABELS.items():
            edit = QKeySequenceEdit(QKeySequence(current.get(name, "")))
            edit.setMaximumSequenceLength(1)
            self.edits[name] = edit
            layout.addRow(label, edit)
        buttons = QDialogButtonBox(
            QDialogButtonBox.Ok | QDialogButtonBox.Cancel | QDialogButtonBox.RestoreDefaults
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        buttons.button(QDialogButtonBox.RestoreDefaults).clicked.connect(self._defaults)
        layout.addRow(buttons)

    def _defaults(self):
        for name, edit in self.edits.items():
            edit.setKeySequence(QKeySequence(DEFAULT_HOTKEYS[name]))

    def values(self):
        return {n: e.keySequence().toString() for n, e in self.edits.items()}


# --------------------------------------------------------------------------
# Main window
# --------------------------------------------------------------------------
class VideoView(QVideoWidget):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner
        self.setContextMenuPolicy(Qt.CustomContextMenu)
        self.customContextMenuRequested.connect(self._context_menu)

    def _context_menu(self, pos):
        menu = self.owner.build_menu(QMenu(self))
        menu.exec(self.mapToGlobal(pos))
        menu.deleteLater()
        # build_menu re-points the volume slider/mute refs at the popup; restore them.
        self.owner._rebuild_menubar()

    def mouseDoubleClickEvent(self, e):
        self.owner.toggle_fullscreen()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.settings = QSettings("LocalStreamer", "LocalStreamer")
        self.setWindowTitle(APP_NAME)
        self.resize(1280, 720)
        self.setStyleSheet("QMainWindow { background: black; }")

        # Media pipeline
        self.session = QMediaCaptureSession()
        self.camera = None
        self.audio_in = QAudioInput()
        self.audio_out = QAudioOutput()
        self.session.setAudioInput(self.audio_in)
        self.session.setAudioOutput(self.audio_out)

        self.video = VideoView(self)
        self.video.setAspectRatioMode(Qt.KeepAspectRatio)
        self.session.setVideoOutput(self.video)
        self.setCentralWidget(self.video)

        # Volume OSD
        self.osd = QLabel(self)
        self.osd.setStyleSheet(
            "background: rgba(0,0,0,170); color: white; font-size: 20px;"
            "padding: 8px 16px; border-radius: 8px;"
        )
        self.osd.hide()
        self.osd_timer = QTimer(self, singleShot=True, interval=1200, timeout=self.osd.hide)

        # State from settings
        self.volume = int(self.settings.value("volume", 80))
        self.muted = self.settings.value("muted", False, type=bool)
        self.hotkeys = {
            n: self.settings.value(f"hotkeys/{n}", d) for n, d in DEFAULT_HOTKEYS.items()
        }
        self._apply_volume(show=False)

        # Local (focused-window) shortcuts
        self._add_shortcut("F11", self.toggle_fullscreen)
        self._add_shortcut("Esc", self.leave_fullscreen)
        self._add_shortcut("Ctrl+H", self.toggle_menubar)

        self.menuBar().setStyleSheet("QMenuBar { background: #222; color: #ddd; }")
        self.menuBar().installEventFilter(self)
        self._rebuild_menubar()
        self.menuBar().setVisible(self.settings.value("menubar", True, type=bool))

        # Device hot-plug
        self.media_devices = QMediaDevices(self)
        self.media_devices.videoInputsChanged.connect(self._rebuild_menubar)
        self.media_devices.audioInputsChanged.connect(self._rebuild_menubar)
        self.media_devices.audioOutputsChanged.connect(self._rebuild_menubar)

        self._select_initial_devices()

        geo = self.settings.value("geometry")
        if geo is not None:
            self.restoreGeometry(geo)

        self.global_hotkeys = GlobalHotkeys(int(self.winId()))
        self._register_hotkeys(warn=True)

    # ---------------- device selection ----------------
    def _select_initial_devices(self):
        cams = QMediaDevices.videoInputs()
        saved_cam = self.settings.value("video_device", "")
        cam = (
            next((c for c in cams if c.description() == saved_cam), None)
            or next((c for c in cams if PREFERRED_VIDEO in c.description().lower()), None)
            or (cams[0] if cams else None)
        )
        if cam:
            self.set_video_device(cam, self.settings.value("video_format", ""))

        ains = QMediaDevices.audioInputs()
        saved_ain = self.settings.value("audio_input", "")
        ain = (
            next((a for a in ains if a.description() == saved_ain), None)
            or next((a for a in ains if PREFERRED_AUDIO in a.description().lower()), None)
        )
        if ain:
            self.audio_in.setDevice(ain)

        outs = QMediaDevices.audioOutputs()
        saved_out = self.settings.value("audio_output", "")
        out = next((o for o in outs if o.description() == saved_out), None)
        self.audio_out.setDevice(out or QMediaDevices.defaultAudioOutput())
        self._rebuild_menubar()

    @staticmethod
    def _fmt_key(f):
        r = f.resolution()
        return f"{r.width()}x{r.height()}@{round(f.maxFrameRate())}:{f.pixelFormat().name}"

    @staticmethod
    def _fmt_label(f):
        r = f.resolution()
        pf = f.pixelFormat().name.replace("Format_", "")
        return f"{r.width()} x {r.height()}  @ {f.maxFrameRate():g} fps  ({pf})"

    def _formats(self, device):
        """Unique formats, sorted by resolution then fps, highest first."""
        seen, out = set(), []
        for f in device.videoFormats():
            k = self._fmt_key(f)
            if k not in seen:
                seen.add(k)
                out.append(f)
        out.sort(
            key=lambda f: (f.resolution().width() * f.resolution().height(), f.maxFrameRate()),
            reverse=True,
        )
        return out

    def _default_format(self, device):
        fmts = self._formats(device)
        # Prefer 1080p at the highest frame rate; fall back to the first listed.
        p1080 = [f for f in fmts if f.resolution().height() == 1080 and f.resolution().width() == 1920]
        p1080 = [f for f in p1080 if f.maxFrameRate() <= 61] or p1080
        return (p1080 or fmts or [None])[0]

    def set_video_device(self, device, fmt_key=""):
        if self.camera:
            self.camera.stop()
            self.camera.deleteLater()
        self.camera = QCamera(device)
        self.camera.errorOccurred.connect(self._camera_error)
        fmt = next((f for f in self._formats(device) if self._fmt_key(f) == fmt_key), None)
        fmt = fmt or self._default_format(device)
        if fmt is not None:
            self.camera.setCameraFormat(fmt)
            self.settings.setValue("video_format", self._fmt_key(fmt))
        self.session.setCamera(self.camera)
        self.camera.start()
        self.settings.setValue("video_device", device.description())
        self.setWindowTitle(f"{APP_NAME} - {device.description()}")

    def set_video_format(self, fmt):
        if not self.camera:
            return
        self.set_video_device(self.camera.cameraDevice(), self._fmt_key(fmt))
        self._rebuild_menubar()

    def set_audio_input(self, dev):
        self.audio_in.setDevice(dev)
        self.audio_in.setMuted(False)
        self.settings.setValue("audio_input", dev.description())

    def disable_audio_input(self):
        self.audio_in.setMuted(True)
        self.settings.setValue("audio_input", "")

    def set_audio_output(self, dev):
        self.audio_out.setDevice(dev)
        self.settings.setValue("audio_output", dev.description())

    def _camera_error(self, err, msg):
        if err != QCamera.NoError:
            self.show_osd(f"Video error: {msg}", ms=5000)

    # ---------------- volume ----------------
    def _apply_volume(self, show=True):
        self.volume = max(0, min(100, self.volume))
        self.audio_out.setVolume(self.volume / 100.0)
        self.audio_out.setMuted(self.muted)
        self.settings.setValue("volume", self.volume)
        self.settings.setValue("muted", self.muted)
        if hasattr(self, "mute_action"):
            self.mute_action.setChecked(self.muted)
        if hasattr(self, "vol_slider") and self.vol_slider.value() != self.volume:
            self.vol_slider.blockSignals(True)
            self.vol_slider.setValue(self.volume)
            self.vol_slider.blockSignals(False)
        if hasattr(self, "vol_label"):
            self.vol_label.setText(self._vol_text())
        if show:
            self.show_osd(self._vol_text())

    def _vol_text(self):
        return f"Volume: {'MUTED' if self.muted else f'{self.volume}%'}"

    def volume_up(self):
        self.muted = False
        self.volume += VOLUME_STEP
        self._apply_volume()

    def volume_down(self):
        self.volume -= VOLUME_STEP
        self._apply_volume()

    def toggle_mute(self):
        self.muted = not self.muted
        self._apply_volume()

    def set_volume(self, v):
        self.volume = v
        self.muted = False
        self._apply_volume()

    def show_osd(self, text, ms=1200):
        self.osd.setText(text)
        self.osd.adjustSize()
        self.osd.move(20, (self.menuBar().height() if self.menuBar().isVisible() else 0) + 20)
        self.osd.raise_()
        self.osd.show()
        self.osd_timer.start(ms)

    # ---------------- hotkeys ----------------
    def _register_hotkeys(self, warn=False):
        failures = self.global_hotkeys.register(self.hotkeys)
        if failures and warn:
            QMessageBox.warning(
                self, APP_NAME,
                "These global hotkeys could not be registered (another app may be using them):\n\n"
                + "\n".join(failures) + "\n\nChange them under Audio > Hotkeys...",
            )
        return failures

    def edit_hotkeys(self):
        dlg = HotkeyDialog(self.hotkeys, self)
        if dlg.exec() == QDialog.Accepted:
            self.hotkeys = dlg.values()
            for n, v in self.hotkeys.items():
                self.settings.setValue(f"hotkeys/{n}", v)
            self._register_hotkeys(warn=True)
            self._rebuild_menubar()

    def nativeEvent(self, event_type, message):
        if event_type == b"windows_generic_MSG" or event_type == "windows_generic_MSG":
            msg = wintypes.MSG.from_address(int(message))
            if msg.message == WM_HOTKEY:
                name = self.global_hotkeys.ids.get(msg.wParam)
                {"volume_up": self.volume_up, "volume_down": self.volume_down,
                 "mute": self.toggle_mute}.get(name, lambda: None)()
                return True, 0
        return super().nativeEvent(event_type, message)

    def _add_shortcut(self, seq, fn):
        a = QAction(self)
        a.setShortcut(QKeySequence(seq))
        a.setShortcutContext(Qt.WindowShortcut)
        a.triggered.connect(fn)
        self.addAction(a)

    # ---------------- view ----------------
    def toggle_fullscreen(self):
        if self.isFullScreen():
            self.leave_fullscreen()
        else:
            self._menubar_before_fs = self.menuBar().isVisible()
            self.menuBar().hide()
            self.showFullScreen()

    def leave_fullscreen(self):
        if self.isFullScreen():
            self.showNormal()
            self.menuBar().setVisible(getattr(self, "_menubar_before_fs", True))

    def toggle_menubar(self):
        vis = not self.menuBar().isVisible()
        self.menuBar().setVisible(vis)
        self.settings.setValue("menubar", vis)
        if not vis:
            self.show_osd("Menu hidden - right-click or Ctrl+H to show", ms=2500)

    # ---------------- menus ----------------
    def _rebuild_menubar(self):
        mb = self.menuBar()
        mb.clear()
        self.build_menu(mb)

    def build_menu(self, root):
        """Populate a QMenuBar or QMenu with the full app menu."""
        # --- Video ---
        vmenu = root.addMenu("&Video")
        src = vmenu.addMenu("Source")
        grp = QActionGroup(src)
        current = self.camera.cameraDevice().id() if self.camera else None
        cams = QMediaDevices.videoInputs()
        for cam in cams:
            a = src.addAction(cam.description())
            a.setCheckable(True)
            a.setChecked(cam.id() == current)
            grp.addAction(a)
            a.triggered.connect(lambda _=False, c=cam: (self.set_video_device(c), self._rebuild_menubar()))
        if not cams:
            src.addAction("(no video devices found)").setEnabled(False)

        fmenu = vmenu.addMenu("Resolution / frame rate")
        if self.camera:
            fgrp = QActionGroup(fmenu)
            cur_fmt = self._fmt_key(self.camera.cameraFormat())
            for f in self._formats(self.camera.cameraDevice()):
                a = fmenu.addAction(self._fmt_label(f))
                a.setCheckable(True)
                a.setChecked(self._fmt_key(f) == cur_fmt)
                fgrp.addAction(a)
                a.triggered.connect(lambda _=False, f=f: self.set_video_format(f))
        vmenu.addSeparator()
        a = vmenu.addAction("Fullscreen\tF11 / double-click")
        a.triggered.connect(self.toggle_fullscreen)
        a = vmenu.addAction("Show menu bar\tCtrl+H")
        a.setCheckable(True)
        a.setChecked(self.menuBar().isVisible())
        a.triggered.connect(self.toggle_menubar)
        a = vmenu.addAction("Always on top")
        a.setCheckable(True)
        a.setChecked(bool(self.windowFlags() & Qt.WindowStaysOnTopHint))
        a.triggered.connect(self.toggle_on_top)

        # --- Audio ---
        amenu = root.addMenu("&Audio")
        ain = amenu.addMenu("Input (capture audio)")
        igrp = QActionGroup(ain)
        cur_in = self.audio_in.device().id()
        none = ain.addAction("None (no audio)")
        none.setCheckable(True)
        none.setChecked(self.audio_in.isMuted())
        igrp.addAction(none)
        none.triggered.connect(lambda: (self.disable_audio_input(), self._rebuild_menubar()))
        for dev in QMediaDevices.audioInputs():
            a = ain.addAction(dev.description())
            a.setCheckable(True)
            a.setChecked(dev.id() == cur_in and not self.audio_in.isMuted())
            igrp.addAction(a)
            a.triggered.connect(lambda _=False, d=dev: (self.set_audio_input(d), self._rebuild_menubar()))

        aout = amenu.addMenu("Output (play through)")
        ogrp = QActionGroup(aout)
        cur_out = self.audio_out.device().id()
        for dev in QMediaDevices.audioOutputs():
            a = aout.addAction(dev.description())
            a.setCheckable(True)
            a.setChecked(dev.id() == cur_out)
            ogrp.addAction(a)
            a.triggered.connect(lambda _=False, d=dev: (self.set_audio_output(d), self._rebuild_menubar()))

        amenu.addSeparator()
        # Inline volume slider
        self.vol_label = QLabel(self._vol_text())
        self.vol_label.setStyleSheet("padding: 4px 12px;")
        la = QWidgetAction(amenu)
        la.setDefaultWidget(self.vol_label)
        amenu.addAction(la)
        self.vol_slider = QSlider(Qt.Horizontal)
        self.vol_slider.setRange(0, 100)
        self.vol_slider.setValue(self.volume)
        self.vol_slider.setMinimumWidth(200)
        self.vol_slider.setStyleSheet("margin: 4px 12px;")
        self.vol_slider.valueChanged.connect(self.set_volume)
        sa = QWidgetAction(amenu)
        sa.setDefaultWidget(self.vol_slider)
        amenu.addAction(sa)

        hk = self.hotkeys
        a = amenu.addAction(f"Volume up\t{hk['volume_up']}")
        a.triggered.connect(self.volume_up)
        a = amenu.addAction(f"Volume down\t{hk['volume_down']}")
        a.triggered.connect(self.volume_down)
        self.mute_action = amenu.addAction(f"Mute\t{hk['mute']}")
        self.mute_action.setCheckable(True)
        self.mute_action.setChecked(self.muted)
        self.mute_action.triggered.connect(self.toggle_mute)
        amenu.addSeparator()
        amenu.addAction("Hotkeys...").triggered.connect(self.edit_hotkeys)
        return root

    def toggle_on_top(self, on):
        self.setWindowFlag(Qt.WindowStaysOnTopHint, on)
        self.show()
        # Re-register: changing flags can recreate the native window.
        self.global_hotkeys.unregister_all()
        self.global_hotkeys.hwnd = int(self.winId())
        self._register_hotkeys()

    def resizeEvent(self, e):
        super().resizeEvent(e)
        if self.osd.isVisible():
            self.osd.move(20, (self.menuBar().height() if self.menuBar().isVisible() else 0) + 20)

    def closeEvent(self, e):
        self.global_hotkeys.unregister_all()
        if not self.isFullScreen():
            self.settings.setValue("geometry", self.saveGeometry())
        if self.camera:
            self.camera.stop()
        super().closeEvent(e)


def main():
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    w = MainWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
