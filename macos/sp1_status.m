#import "sp1_status.h"
#import <signal.h>
#import <errno.h>

static NSString *const SP1_DIR = @"/Users/geonhee/Desktop/Important/Security-Protocol-1";

// Read the last maxLines lines of a possibly large log file without loading it all.
static NSArray<NSString *> *tailLines(NSString *path, NSUInteger maxBytes, NSUInteger maxLines) {
    NSFileHandle *fh = [NSFileHandle fileHandleForReadingAtPath:path];
    if (!fh) return @[];
    unsigned long long size = [fh seekToEndOfFile];
    unsigned long long offset = size > maxBytes ? size - maxBytes : 0;
    [fh seekToFileOffset:offset];
    NSData *data = [fh readDataToEndOfFile];
    [fh closeFile];

    // If we started mid-file we may have cut a UTF-8 sequence; skip bytes until it decodes.
    NSString *text = nil;
    for (NSUInteger skip = 0; skip < 4 && skip < data.length && text == nil; skip++) {
        text = [[NSString alloc] initWithData:[data subdataWithRange:NSMakeRange(skip, data.length - skip)]
                                     encoding:NSUTF8StringEncoding];
    }
    if (!text) return @[];

    NSMutableArray<NSString *> *lines = [[text componentsSeparatedByString:@"\n"] mutableCopy];
    if (offset > 0 && lines.count > 0) [lines removeObjectAtIndex:0]; // drop partial first line
    while (lines.count > 0 && lines.lastObject.length == 0) [lines removeLastObject];
    if (lines.count > maxLines) {
        return [lines subarrayWithRange:NSMakeRange(lines.count - maxLines, maxLines)];
    }
    return lines;
}

// True only if the pid is alive AND is actually the watcher script
// (guards against a stale lock file whose pid got reused).
static BOOL pidIsWatcher(int pid) {
    if (pid <= 0) return NO;
    errno = 0;
    if (kill(pid, 0) != 0 && errno != EPERM) return NO;

    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/ps"];
    task.arguments = @[ @"-p", [NSString stringWithFormat:@"%d", pid], @"-o", @"command=" ];
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = [NSPipe pipe];
    NSError *err = nil;
    if (![task launchAndReturnError:&err]) return YES; // ps unavailable; trust kill()
    [task waitUntilExit];
    NSData *out = [pipe.fileHandleForReading readDataToEndOfFile];
    NSString *cmd = [[NSString alloc] initWithData:out encoding:NSUTF8StringEncoding] ?: @"";
    return [cmd containsString:@"security_protocol"];
}

// ntfy.sh reachability, cached for 60s so 5s UI polling doesn't spam the network.
static NSNumber *ntfyReachable(void) {
    static NSNumber *cached = nil;
    static NSTimeInterval cachedAt = 0;
    NSTimeInterval now = [NSDate date].timeIntervalSince1970;
    if (cached != nil && now - cachedAt < 60) return cached;

    NSMutableURLRequest *req =
        [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://ntfy.sh/v1/health"]];
    req.timeoutInterval = 3.0;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block BOOL ok = NO;
    NSURLSessionDataTask *task = [[NSURLSession sharedSession]
        dataTaskWithRequest:req
          completionHandler:^(NSData *data, NSURLResponse *resp, NSError *error) {
              ok = (error == nil && [(NSHTTPURLResponse *)resp statusCode] == 200);
              dispatch_semaphore_signal(sem);
          }];
    [task resume];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4 * NSEC_PER_SEC)));

    cached = @(ok);
    cachedAt = now;
    return cached;
}

NSDictionary *SP1CollectStatus(void) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSMutableDictionary *out = [NSMutableDictionary dictionary];

    // watcher process (pid from the file lock)
    NSString *lockPath = [SP1_DIR stringByAppendingPathComponent:@".security_protocol.lock"];
    NSString *pidStr = [[NSString stringWithContentsOfFile:lockPath
                                                  encoding:NSUTF8StringEncoding
                                                     error:nil]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    int pid = pidStr.intValue;
    BOOL running = pidIsWatcher(pid);
    out[@"watcherPid"] = @(pid);
    out[@"watcherRunning"] = @(running);

    // Log analysis. Recent lines can be pure gesture spam, so the last
    // state-changing marker may sit far back — scan a deep tail natively and
    // hand JS only the found marker line plus a short tail for the event feed.
    // Marker strings mirror the log() calls in security_protocol.py.
    NSArray<NSString *> *lines =
        tailLines([SP1_DIR stringByAppendingPathComponent:@"protocol.log"], 4 * 1024 * 1024, NSUIntegerMax);
    NSArray<NSString *> *stateMarkers = @[
        @"입력 차단 활성화",          // lockdown engaged (shade phase)
        @"[LOCK] UNLOCK 선택",       // auth phase entered
        @"[LOCKOUT]",                // attempts exhausted, still locked
        @"[OPEN] 락다운 해제",        // released (every release path logs this)
        @"[ESC] 비상 키",            // emergency escape
        @"Security-Protocol-1 가동", // fresh start = unlocked
    ];
    NSString *stateLine = nil;
    NSString *failLine = nil; // most recent fail AFTER the state marker only
    for (NSInteger i = (NSInteger)lines.count - 1; i >= 0 && stateLine == nil; i--) {
        NSString *l = lines[i];
        if (failLine == nil && [l containsString:@"[FAIL] 해제 실패"]) failLine = l;
        for (NSString *m in stateMarkers) {
            if ([l containsString:m]) { stateLine = l; break; }
        }
    }
    out[@"stateLine"] = stateLine ?: (id)[NSNull null];
    out[@"failLine"] = failLine ?: (id)[NSNull null];
    out[@"logTail"] = lines.count > 30
        ? [lines subarrayWithRange:NSMakeRange(lines.count - 30, 30)]
        : lines;

    // intrusion snapshots
    NSUInteger intruders = 0;
    for (NSString *f in [fm contentsOfDirectoryAtPath:[SP1_DIR stringByAppendingPathComponent:@"intruders"]
                                                error:nil]) {
        if (![f hasPrefix:@"."]) intruders++;
    }
    out[@"intruderCount"] = @(intruders);

    // autostart launch agent
    BOOL autostart = NO;
    NSString *agentsDir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/LaunchAgents"];
    for (NSString *f in [fm contentsOfDirectoryAtPath:agentsDir error:nil]) {
        if ([f containsString:@"security-protocol-1"]) { autostart = YES; break; }
    }
    out[@"autostartInstalled"] = @(autostart);

    // components
    out[@"appBundle"] = @([fm fileExistsAtPath:[SP1_DIR stringByAppendingPathComponent:@"SecurityProtocol1.app"]]);
    out[@"modelPresent"] = @([fm fileExistsAtPath:
        [SP1_DIR stringByAppendingPathComponent:@"models/gesture_recognizer.task"]]);

    // config — expose flags only, never topic/token/gesture values
    NSData *cfgData = [NSData dataWithContentsOfFile:
        [SP1_DIR stringByAppendingPathComponent:@"config.local.json"]];
    NSDictionary *cfg = nil;
    if (cfgData) {
        id parsed = [NSJSONSerialization JSONObjectWithData:cfgData options:0 error:nil];
        if ([parsed isKindOfClass:[NSDictionary class]]) cfg = parsed;
    }
    out[@"configPresent"] = @(cfg != nil);
    NSDictionary *notify = [cfg[@"notify"] isKindOfClass:[NSDictionary class]] ? cfg[@"notify"] : @{};
    NSDictionary *remote = [cfg[@"remote"] isKindOfClass:[NSDictionary class]] ? cfg[@"remote"] : @{};
    NSString *provider = [notify[@"provider"] isKindOfClass:[NSString class]] ? notify[@"provider"] : @"none";
    out[@"notifyProvider"] = provider;
    out[@"ntfyTopicSet"] = @([notify[@"ntfy_topic"] isKindOfClass:[NSString class]] &&
                             [notify[@"ntfy_topic"] length] > 0);
    BOOL remoteEnabled = [remote[@"enabled"] boolValue];
    out[@"remoteEnabled"] = @(remoteEnabled);
    out[@"remoteUnlockAllowed"] = @([remote[@"allow_unlock"] boolValue]);

    // ntfy server check only matters if something actually uses ntfy
    if ([provider isEqualToString:@"ntfy"] || remoteEnabled) {
        out[@"ntfyReachable"] = ntfyReachable();
    } else {
        out[@"ntfyReachable"] = [NSNull null];
    }

    return out;
}
