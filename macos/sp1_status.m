#import "sp1_status.h"
#import <ImageIO/ImageIO.h>
#import <signal.h>
#import <errno.h>
#import <unistd.h>

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

static NSString *runTool(NSString *path, NSArray<NSString *> *args) {
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:path];
    task.arguments = args;
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = [NSPipe pipe];
    NSError *err = nil;
    if (![task launchAndReturnError:&err]) return nil;
    [task waitUntilExit];
    NSData *out = [pipe.fileHandleForReading readDataToEndOfFile];
    return [[NSString alloc] initWithData:out encoding:NSUTF8StringEncoding];
}

// True only if the pid is alive AND is actually the watcher script
// (guards against a stale lock file whose pid got reused).
static BOOL pidIsWatcher(int pid) {
    if (pid <= 0) return NO;
    errno = 0;
    if (kill(pid, 0) != 0 && errno != EPERM) return NO;
    NSString *cmd = runTool(@"/bin/ps",
        @[ @"-p", [NSString stringWithFormat:@"%d", pid], @"-o", @"command=" ]);
    if (cmd == nil) return YES; // ps unavailable; trust kill()
    return [cmd containsString:@"security_protocol"];
}

int SP1RunningWatcherPid(void) {
    NSString *lockPath = [SP1_DIR stringByAppendingPathComponent:@".security_protocol.lock"];
    NSString *pidStr = [[NSString stringWithContentsOfFile:lockPath
                                                  encoding:NSUTF8StringEncoding
                                                     error:nil]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    int pid = pidStr.intValue;
    return pidIsWatcher(pid) ? pid : 0;
}

// ─── watcher pause/resume (for Omni hand-control camera sharing) ───

static int gPauseMethod = 0; // 0 = not paused, 1 = via launchd, 2 = manual SIGTERM

static NSString *sp1AgentPlist(NSString **labelOut) {
    NSString *agentsDir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/LaunchAgents"];
    for (NSString *f in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:agentsDir error:nil]) {
        if ([f containsString:@"security-protocol-1"] &&
            [f.pathExtension isEqualToString:@"plist"]) {
            if (labelOut) *labelOut = [f stringByDeletingPathExtension];
            return [agentsDir stringByAppendingPathComponent:f];
        }
    }
    return nil;
}

BOOL SP1PauseWatcher(void) {
    int pid = SP1RunningWatcherPid();
    if (pid <= 0) return NO;

    NSString *label = nil;
    NSString *plist = sp1AgentPlist(&label);
    BOOL viaLaunchd = NO;
    if (plist != nil && label != nil) {
        NSString *list = runTool(@"/bin/launchctl", @[ @"list" ]);
        viaLaunchd = (list != nil && [list containsString:label]);
    }
    if (viaLaunchd) {
        runTool(@"/bin/launchctl", @[
            @"bootout", [NSString stringWithFormat:@"gui/%d/%@", getuid(), label]
        ]);
        gPauseMethod = 1;
    } else {
        kill(pid, SIGTERM);
        gPauseMethod = 2;
    }

    // wait for the process to exit — only then is the camera actually released
    for (int i = 0; i < 40; i++) {
        errno = 0;
        if (kill(pid, 0) != 0 && errno == ESRCH) return YES;
        usleep(100000);
    }
    return NO;
}

BOOL SP1StartWatcher(void) {
    if (SP1RunningWatcherPid() > 0) return YES;
    gPauseMethod = 0; // manual start supersedes any stale pause bookkeeping
    NSString *label = nil;
    NSString *plist = sp1AgentPlist(&label);
    if (plist != nil) {
        NSString *gui = [NSString stringWithFormat:@"gui/%d", getuid()];
        runTool(@"/bin/launchctl", @[ @"bootstrap", gui, plist ]);
        if (label != nil) {
            // if the job was already loaded but idle, kick it explicitly
            runTool(@"/bin/launchctl",
                    @[ @"kickstart", [NSString stringWithFormat:@"%@/%@", gui, label] ]);
        }
    } else {
        runTool(@"/usr/bin/open",
                @[ [SP1_DIR stringByAppendingPathComponent:@"SecurityProtocol1.app"] ]);
    }
    for (int i = 0; i < 60; i++) { // watcher writes its pid lock early in startup
        if (SP1RunningWatcherPid() > 0) return YES;
        usleep(100000);
    }
    return NO;
}

void SP1ResumeWatcher(void) {
    if (gPauseMethod == 1) {
        NSString *label = nil;
        NSString *plist = sp1AgentPlist(&label);
        if (plist != nil) {
            runTool(@"/bin/launchctl", @[
                @"bootstrap", [NSString stringWithFormat:@"gui/%d", getuid()], plist
            ]);
        }
    } else if (gPauseMethod == 2) {
        runTool(@"/usr/bin/open",
                @[ [SP1_DIR stringByAppendingPathComponent:@"SecurityProtocol1.app"] ]);
    }
    gPauseMethod = 0;
}

// ntfy.sh reachability + latency, cached for 60s so 5s UI polling doesn't spam the network.
static void ntfyCheck(NSNumber **reachable, NSNumber **latencyMs) {
    static NSNumber *cachedOk = nil;
    static NSNumber *cachedMs = nil;
    static NSTimeInterval cachedAt = 0;
    NSTimeInterval now = [NSDate date].timeIntervalSince1970;
    if (cachedOk != nil && now - cachedAt < 60) {
        *reachable = cachedOk;
        *latencyMs = cachedMs;
        return;
    }

    NSMutableURLRequest *req =
        [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://ntfy.sh/v1/health"]];
    req.timeoutInterval = 3.0;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block BOOL ok = NO;
    NSDate *t0 = [NSDate date];
    __block NSTimeInterval elapsed = 0;
    NSURLSessionDataTask *task = [[NSURLSession sharedSession]
        dataTaskWithRequest:req
          completionHandler:^(NSData *data, NSURLResponse *resp, NSError *error) {
              ok = (error == nil && [(NSHTTPURLResponse *)resp statusCode] == 200);
              elapsed = -[t0 timeIntervalSinceNow];
              dispatch_semaphore_signal(sem);
          }];
    [task resume];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4 * NSEC_PER_SEC)));

    cachedOk = @(ok);
    cachedMs = ok ? @((int)(elapsed * 1000)) : nil;
    cachedAt = now;
    *reachable = cachedOk;
    *latencyMs = cachedMs;
}

NSDictionary *SP1CollectStatus(void) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    out[@"now"] = @([NSDate date].timeIntervalSince1970);

    // ── watcher process (pid from the file lock) ──
    NSString *lockPath = [SP1_DIR stringByAppendingPathComponent:@".security_protocol.lock"];
    NSString *pidStr = [[NSString stringWithContentsOfFile:lockPath
                                                  encoding:NSUTF8StringEncoding
                                                     error:nil]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    int pid = pidStr.intValue;
    BOOL running = pidIsWatcher(pid);
    out[@"watcherPid"] = @(pid);
    out[@"watcherRunning"] = @(running);

    NSDate *lockMtime = [fm attributesOfItemAtPath:lockPath error:nil][NSFileModificationDate];
    out[@"watcherSince"] = (running && lockMtime) ? @(lockMtime.timeIntervalSince1970) : (id)[NSNull null];

    // process telemetry (cpu %, resident memory, run state)
    out[@"watcherCpu"] = [NSNull null];
    out[@"watcherMemBytes"] = [NSNull null];
    out[@"watcherStopped"] = @NO; // SIGSTOPped (e.g. while Omni hand control runs)
    if (running) {
        NSString *ps = runTool(@"/bin/ps",
            @[ @"-p", [NSString stringWithFormat:@"%d", pid], @"-o", @"%cpu=,rss=,state=" ]);
        NSArray<NSString *> *parts = [ps componentsSeparatedByCharactersInSet:
            [NSCharacterSet whitespaceAndNewlineCharacterSet]];
        NSMutableArray<NSString *> *vals = [NSMutableArray array];
        for (NSString *p in parts) if (p.length > 0) [vals addObject:p];
        if (vals.count >= 2) {
            out[@"watcherCpu"] = @(vals[0].doubleValue);
            out[@"watcherMemBytes"] = @(vals[1].longLongValue * 1024);
        }
        if (vals.count >= 3) {
            out[@"watcherStopped"] = @([vals[2] containsString:@"T"]);
        }
    }

    // ── log analysis ──
    // Recent lines can be pure gesture spam, so the last state-changing marker
    // may sit far back — scan a deep tail natively and hand JS only the found
    // marker line plus a short tail for the event feed / activity stats.
    // Marker strings mirror the log() calls in security_protocol.py.
    NSString *logPath = [SP1_DIR stringByAppendingPathComponent:@"protocol.log"];
    NSArray<NSString *> *lines = tailLines(logPath, 4 * 1024 * 1024, NSUIntegerMax);
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
    out[@"logTail"] = lines.count > 80
        ? [lines subarrayWithRange:NSMakeRange(lines.count - 80, 80)]
        : lines;

    NSDictionary *logAttrs = [fm attributesOfItemAtPath:logPath error:nil];
    out[@"logSizeBytes"] = logAttrs[NSFileSize] ?: (id)[NSNull null];
    NSDate *logMtime = logAttrs[NSFileModificationDate];
    out[@"logMtime"] = logMtime ? @(logMtime.timeIntervalSince1970) : (id)[NSNull null];

    // ── intrusion snapshots ──
    NSString *intrudersDir = [SP1_DIR stringByAppendingPathComponent:@"intruders"];
    NSUInteger intruders = 0;
    NSDate *lastIntrusion = nil;
    for (NSString *f in [fm contentsOfDirectoryAtPath:intrudersDir error:nil]) {
        if ([f hasPrefix:@"."]) continue;
        intruders++;
        NSDate *m = [fm attributesOfItemAtPath:[intrudersDir stringByAppendingPathComponent:f]
                                         error:nil][NSFileModificationDate];
        if (m && (lastIntrusion == nil || [m compare:lastIntrusion] == NSOrderedDescending)) {
            lastIntrusion = m;
        }
    }
    out[@"intruderCount"] = @(intruders);
    out[@"lastIntrusionAt"] = lastIntrusion ? @(lastIntrusion.timeIntervalSince1970) : (id)[NSNull null];

    // ── autostart launch agent ──
    NSString *agentFile = nil;
    NSString *agentsDir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/LaunchAgents"];
    for (NSString *f in [fm contentsOfDirectoryAtPath:agentsDir error:nil]) {
        if ([f containsString:@"security-protocol-1"]) { agentFile = f; break; }
    }
    out[@"autostartInstalled"] = @(agentFile != nil);
    out[@"agentLabel"] = agentFile ? [agentFile stringByDeletingPathExtension] : (id)[NSNull null];
    // `launchctl list` dumps every user agent — cache it, this rarely changes
    static BOOL cachedLoaded = NO;
    static NSTimeInterval loadedAt = 0;
    NSTimeInterval nowTs = [NSDate date].timeIntervalSince1970;
    if (agentFile != nil && nowTs - loadedAt > 30) {
        NSString *list = runTool(@"/bin/launchctl", @[ @"list" ]);
        cachedLoaded = list != nil && [list containsString:[agentFile stringByDeletingPathExtension]];
        loadedAt = nowTs;
    }
    out[@"agentLoaded"] = @(agentFile != nil && cachedLoaded);

    // ── components ──
    out[@"appBundle"] = @([fm fileExistsAtPath:[SP1_DIR stringByAppendingPathComponent:@"SecurityProtocol1.app"]]);
    NSString *modelPath = [SP1_DIR stringByAppendingPathComponent:@"models/gesture_recognizer.task"];
    out[@"modelPresent"] = @([fm fileExistsAtPath:modelPath]);
    out[@"modelSizeBytes"] = [fm attributesOfItemAtPath:modelPath error:nil][NSFileSize] ?: (id)[NSNull null];

    // ── config — expose flags only, never topic/token/gesture values ──
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
    out[@"maxUnlockAttempts"] = [cfg[@"max_unlock_attempts"] isKindOfClass:[NSNumber class]]
        ? cfg[@"max_unlock_attempts"] : @5;

    // ── ntfy server check — only matters if something actually uses ntfy ──
    if ([provider isEqualToString:@"ntfy"] || remoteEnabled) {
        NSNumber *reachable = nil, *latency = nil;
        ntfyCheck(&reachable, &latency);
        out[@"ntfyReachable"] = reachable ?: (id)[NSNull null];
        out[@"ntfyLatencyMs"] = latency ?: (id)[NSNull null];
    } else {
        out[@"ntfyReachable"] = [NSNull null];
        out[@"ntfyLatencyMs"] = [NSNull null];
    }

    return out;
}

// ─── intruder gallery ───

// Decode + downscale + re-encode as JPEG base64 (pure ImageIO, no AppKit).
static NSString *jpegBase64(NSString *path, CGFloat maxPx, CGFloat quality) {
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageSourceRef src = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!src) return nil;
    NSDictionary *opts = @{
        (id)kCGImageSourceCreateThumbnailFromImageAlways : @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize : @(maxPx),
        (id)kCGImageSourceCreateThumbnailWithTransform : @YES,
    };
    CGImageRef img = CGImageSourceCreateThumbnailAtIndex(src, 0, (__bridge CFDictionaryRef)opts);
    CFRelease(src);
    if (!img) return nil;
    NSMutableData *data = [NSMutableData data];
    CGImageDestinationRef dst = CGImageDestinationCreateWithData(
        (__bridge CFMutableDataRef)data, CFSTR("public.jpeg"), 1, NULL);
    if (!dst) { CGImageRelease(img); return nil; }
    CGImageDestinationAddImage(dst, img,
        (__bridge CFDictionaryRef)@{(id)kCGImageDestinationLossyCompressionQuality : @(quality)});
    BOOL ok = CGImageDestinationFinalize(dst);
    CFRelease(dst);
    CGImageRelease(img);
    return ok ? [data base64EncodedStringWithOptions:0] : nil;
}

NSArray *SP1CollectIntruders(void) {
    // thumbnails are expensive — cache by "name|mtime"
    static NSMutableDictionary<NSString *, NSString *> *cache;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ cache = [NSMutableDictionary dictionary]; });

    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *dir = [SP1_DIR stringByAppendingPathComponent:@"intruders"];
    NSDateFormatter *df = [NSDateFormatter new];
    df.dateFormat = @"yyyyMMdd_HHmmss";
    df.timeZone = [NSTimeZone localTimeZone];

    NSMutableArray *items = [NSMutableArray array];
    for (NSString *f in [fm contentsOfDirectoryAtPath:dir error:nil]) {
        if ([f hasPrefix:@"."] || ![f.pathExtension.lowercaseString isEqualToString:@"jpg"]) continue;
        NSString *path = [dir stringByAppendingPathComponent:f];
        NSDate *mtime = [fm attributesOfItemAtPath:path error:nil][NSFileModificationDate] ?: [NSDate date];

        // filename: YYYYMMDD_HHMMSS_<reason>.jpg (reason itself may contain "_")
        NSString *base = f.stringByDeletingPathExtension;
        NSArray<NSString *> *parts = [base componentsSeparatedByString:@"_"];
        NSString *reason = @"unknown";
        NSDate *shot = nil;
        if (parts.count >= 3) {
            reason = [[parts subarrayWithRange:NSMakeRange(2, parts.count - 2)]
                         componentsJoinedByString:@"_"];
            shot = [df dateFromString:[NSString stringWithFormat:@"%@_%@", parts[0], parts[1]]];
        }
        NSString *key = [NSString stringWithFormat:@"%@|%.0f", f, mtime.timeIntervalSince1970];
        NSString *thumb = cache[key];
        if (thumb == nil) {
            thumb = jpegBase64(path, 360, 0.7);
            if (thumb) cache[key] = thumb;
        }
        [items addObject:@{
            @"name" : f,
            @"epoch" : @((shot ?: mtime).timeIntervalSince1970),
            @"reason" : reason.lowercaseString,
            @"thumb" : thumb ?: (id)[NSNull null],
        }];
    }

    [items sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [b[@"epoch"] compare:a[@"epoch"]]; // newest first
    }];
    if (items.count > 48) [items removeObjectsInRange:NSMakeRange(48, items.count - 48)];
    return items;
}

NSDictionary *SP1IntruderImage(NSString *name) {
    if (![name isKindOfClass:[NSString class]] || name.length == 0) return nil;
    if ([name containsString:@"/"] || [name containsString:@".."]) return nil;
    if (![name.pathExtension.lowercaseString isEqualToString:@"jpg"]) return nil;
    NSString *path = [[SP1_DIR stringByAppendingPathComponent:@"intruders"]
                         stringByAppendingPathComponent:name];
    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) return nil;
    NSString *b64 = jpegBase64(path, 1600, 0.85);
    return b64 ? @{@"name" : name, @"image" : b64} : nil;
}
