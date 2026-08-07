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
