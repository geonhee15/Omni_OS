#import <Foundation/Foundation.h>

// Collects a status snapshot of the Security-Protocol-1 project.
// Blocking (may wait up to ~3s on the ntfy health check) — call off the main thread.
// The returned dictionary is JSON-serializable and never contains secrets
// (topics, tokens, gestures are reduced to booleans).
NSDictionary *SP1CollectStatus(void);

// Lists intruder snapshots (newest first, capped) with inline JPEG thumbnails:
// [{name, epoch, reason, thumb(base64)}]. Thumbnails are cached by file mtime.
NSArray *SP1CollectIntruders(void);

// Full-resolution (capped) image for one snapshot by bare filename.
// Returns {name, image(base64)} or nil if the name is invalid/missing.
NSDictionary *SP1IntruderImage(NSString *name);

// Pid of the running watcher process (verified via ps), or 0 if not running.
int SP1RunningWatcherPid(void);

// Cleanly stops the watcher so it fully releases the camera (a SIGSTOPped
// process keeps its capture session open and stalls the shared camera
// pipeline). Uses launchctl bootout when the agent is loaded (prevents
// KeepAlive respawn), else SIGTERM. Returns YES once the process has exited.
BOOL SP1PauseWatcher(void);

// Brings a paused watcher back: bootstrap the launch agent, or relaunch the
// app bundle for manually-started watchers. No-op if nothing was paused.
void SP1ResumeWatcher(void);

// Starts the watcher regardless of pause state (for the panel's START button
// when the watcher is found offline). Returns YES once it is running.
BOOL SP1StartWatcher(void);
