#[cfg(windows)]
pub fn system_defers_reminders() -> bool {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
            Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL},
        },
        UI::{
            Shell::{
                SHQueryUserNotificationState, QUNS_BUSY, QUNS_NOT_PRESENT, QUNS_PRESENTATION_MODE,
                QUNS_RUNNING_D3D_FULL_SCREEN,
            },
            WindowsAndMessaging::{
                GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetShellWindow,
                GetWindowLongW, GetWindowThreadProcessId, IsIconic, IsZoomed, GWL_STYLE,
                WS_CAPTION,
            },
        },
    };

    // All Win32 calls below only read system state and local stack buffers.
    unsafe {
        let mut state = 0;
        if SHQueryUserNotificationState(&mut state) >= 0
            && matches!(
                state,
                QUNS_BUSY
                    | QUNS_NOT_PRESENT
                    | QUNS_PRESENTATION_MODE
                    | QUNS_RUNNING_D3D_FULL_SCREEN
            )
        {
            return true;
        }
        let foreground = GetForegroundWindow();
        if foreground.is_null()
            || foreground == GetDesktopWindow()
            || foreground == GetShellWindow()
            || IsIconic(foreground) != 0
        {
            return false;
        }
        let mut process = 0;
        GetWindowThreadProcessId(foreground, &mut process);
        if process == std::process::id()
            || (IsZoomed(foreground) != 0
                && (GetWindowLongW(foreground, GWL_STYLE) as u32) & WS_CAPTION == WS_CAPTION)
        {
            return false;
        }
        let mut class = [0u16; 32];
        let length = GetClassNameW(foreground, class.as_mut_ptr(), class.len() as i32);
        if length > 0
            && matches!(
                String::from_utf16_lossy(&class[..length as usize]).as_str(),
                "WorkerW" | "Progman" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            )
        {
            return false;
        }
        // The shell can miss borderless apps. Compare the visible frame with the actual monitor.
        let monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONULL);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let mut bounds = RECT::default();
        if monitor.is_null()
            || GetMonitorInfoW(monitor, &mut info) == 0
            || DwmGetWindowAttribute(
                foreground,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                (&mut bounds as *mut RECT).cast(),
                size_of::<RECT>() as u32,
            ) < 0
        {
            return false;
        }
        let screen = info.rcMonitor;
        bounds.left <= screen.left
            && bounds.top <= screen.top
            && bounds.right >= screen.right
            && bounds.bottom >= screen.bottom
    }
}

#[cfg(not(windows))]
pub fn system_defers_reminders() -> bool {
    false
}
