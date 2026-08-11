#import "arduino_bridge.h"
#import <fcntl.h>
#import <termios.h>
#import <unistd.h>
#import <errno.h>
#import <sys/ioctl.h>

@implementation ArduinoBridge {
    __weak WKWebView *_webView;
    NSTask *_job;
    NSMutableData *_outBuf;
    NSMutableData *_errBuf;
    int _serialFd;
    dispatch_source_t _serialSrc;
    NSString *_editRoot; // sketch folder opened in the editor — write boundary
}

- (instancetype)initWithWebView:(WKWebView *)webView {
    if ((self = [super init])) {
        _webView = webView;
        _serialFd = -1;
    }
    return self;
}

+ (NSString *)cliPath {
    NSArray *candidates = @[
        @"/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli",
        @"/opt/homebrew/bin/arduino-cli",
        @"/usr/local/bin/arduino-cli",
    ];
    for (NSString *p in candidates) {
        if ([[NSFileManager defaultManager] isExecutableFileAtPath:p]) return p;
    }
    return nil;
}

- (void)eval:(NSString *)js {
    dispatch_async(dispatch_get_main_queue(), ^{
        [self->_webView evaluateJavaScript:js completionHandler:nil];
    });
}

// JSON-encode a string for safe inline JS embedding.
static NSString *jsStr(NSString *s) {
    NSData *d = [NSJSONSerialization dataWithJSONObject:@[ s ?: @"" ] options:0 error:nil];
    NSString *arr = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
    return [arr substringWithRange:NSMakeRange(1, arr.length - 2)];
}

// ── cli job ──

- (void)flushBuffer:(NSMutableData *)buf isErr:(BOOL)isErr final:(BOOL)final {
    while (YES) {
        NSRange nl = [buf rangeOfData:[NSData dataWithBytes:"\n" length:1]
                              options:0
                                range:NSMakeRange(0, buf.length)];
        if (nl.location == NSNotFound) break;
        NSData *lineData = [buf subdataWithRange:NSMakeRange(0, nl.location)];
        [buf replaceBytesInRange:NSMakeRange(0, nl.location + 1) withBytes:NULL length:0];
        NSString *line = [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding]
            ?: [[NSString alloc] initWithData:lineData encoding:NSISOLatin1StringEncoding] ?: @"";
        [self eval:[NSString stringWithFormat:
            @"window.OmniArduino && window.OmniArduino._out(%@, %@)",
            jsStr(line), isErr ? @"true" : @"false"]];
    }
    if (final && buf.length > 0) {
        NSString *line = [[NSString alloc] initWithData:buf encoding:NSUTF8StringEncoding] ?: @"";
        [buf setLength:0];
        if (line.length > 0) {
            [self eval:[NSString stringWithFormat:
                @"window.OmniArduino && window.OmniArduino._out(%@, %@)",
                jsStr(line), isErr ? @"true" : @"false"]];
        }
    }
}

- (BOOL)runJob:(NSArray<NSString *> *)args {
    NSString *cli = [ArduinoBridge cliPath];
    if (cli == nil || _job != nil) return NO;

    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:cli];
    task.arguments = args;
    NSPipe *outP = [NSPipe pipe];
    NSPipe *errP = [NSPipe pipe];
    task.standardOutput = outP;
    task.standardError = errP;

    _outBuf = [NSMutableData data];
    _errBuf = [NSMutableData data];
    __weak typeof(self) w = self;

    outP.fileHandleForReading.readabilityHandler = ^(NSFileHandle *h) {
        NSData *d = h.availableData;
        typeof(self) s = w;
        if (s == nil || d.length == 0) return;
        @synchronized (s) {
            [s->_outBuf appendData:d];
            [s flushBuffer:s->_outBuf isErr:NO final:NO];
        }
    };
    errP.fileHandleForReading.readabilityHandler = ^(NSFileHandle *h) {
        NSData *d = h.availableData;
        typeof(self) s = w;
        if (s == nil || d.length == 0) return;
        @synchronized (s) {
            [s->_errBuf appendData:d];
            [s flushBuffer:s->_errBuf isErr:YES final:NO];
        }
    };
    task.terminationHandler = ^(NSTask *t) {
        typeof(self) s = w;
        if (s == nil) return;
        outP.fileHandleForReading.readabilityHandler = nil;
        errP.fileHandleForReading.readabilityHandler = nil;
        @synchronized (s) {
            [s->_outBuf appendData:outP.fileHandleForReading.availableData];
            [s->_errBuf appendData:errP.fileHandleForReading.availableData];
            [s flushBuffer:s->_outBuf isErr:NO final:YES];
            [s flushBuffer:s->_errBuf isErr:YES final:YES];
        }
        s->_job = nil;
        [s eval:[NSString stringWithFormat:
            @"window.OmniArduino && window.OmniArduino._done(%d)",
            t.terminationStatus]];
    };

    NSError *err = nil;
    if (![task launchAndReturnError:&err]) return NO;
    _job = task;
    return YES;
}

- (void)cancelJob {
    [_job terminate];
}

// ── structured queries (parsed natively, compact result) ──

// Runs arduino-cli and returns parsed JSON. Output is read straight into a
// buffer — no per-line JS evaluation, which is what made large --json
// responses (board listall: ~6 MB) lock up the UI.
- (id)runJSON:(NSArray<NSString *> *)args timeout:(NSTimeInterval)timeout {
    NSString *cli = [ArduinoBridge cliPath];
    if (cli == nil) return nil;
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:cli];
    task.arguments = args;
    NSPipe *outP = [NSPipe pipe];
    task.standardOutput = outP;
    task.standardError = [NSPipe pipe];
    NSError *err = nil;
    if (![task launchAndReturnError:&err]) return nil;

    NSMutableData *buf = [NSMutableData data];
    NSFileHandle *fh = outP.fileHandleForReading;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (YES) {
        NSData *chunk = [fh availableData];
        if (chunk.length == 0) break;
        [buf appendData:chunk];
        if ([deadline timeIntervalSinceNow] < 0) {
            [task terminate];
            break;
        }
    }
    [task waitUntilExit];
    if (buf.length == 0) return nil;
    return [NSJSONSerialization JSONObjectWithData:buf options:0 error:nil];
}

static NSString *strOr(id v, NSString *fallback) {
    return [v isKindOfClass:[NSString class]] ? v : fallback;
}

- (NSArray<NSDictionary *> *)listPorts {
    id json = [self runJSON:@[ @"board", @"list", @"--json" ] timeout:20];
    NSArray *ports = [json isKindOfClass:[NSDictionary class]]
        ? (json[@"detected_ports"] ?: json[@"ports"]) : nil;
    NSMutableArray *out = [NSMutableArray array];
    for (id p in (ports ?: @[])) {
        if (![p isKindOfClass:[NSDictionary class]]) continue;
        id portInfo = p[@"port"] ?: p;
        NSString *addr = strOr(portInfo[@"address"], nil);
        if (addr == nil) continue;
        NSArray *matching = [p[@"matching_boards"] isKindOfClass:[NSArray class]]
            ? p[@"matching_boards"] : nil;
        NSDictionary *b = matching.count ? matching[0] : nil;
        [out addObject:@{
            @"address" : addr,
            @"board" : strOr(b[@"name"], @""),
            @"fqbn" : strOr(b[@"fqbn"], @""),
        }];
    }
    return out;
}

- (NSArray<NSDictionary *> *)listBoards {
    id json = [self runJSON:@[ @"board", @"listall", @"--json" ] timeout:40];
    NSArray *boards = [json isKindOfClass:[NSDictionary class]] ? json[@"boards"] : nil;
    NSMutableArray *out = [NSMutableArray array];
    for (id b in (boards ?: @[])) {
        if (![b isKindOfClass:[NSDictionary class]]) continue;
        NSString *fqbn = strOr(b[@"fqbn"], nil);
        if (fqbn == nil) continue;
        [out addObject:@{ @"name" : strOr(b[@"name"], fqbn), @"fqbn" : fqbn }];
    }
    return out;
}

- (NSArray<NSDictionary *> *)listInstalledLibs {
    id json = [self runJSON:@[ @"lib", @"list", @"--json" ] timeout:25];
    NSArray *libs = [json isKindOfClass:[NSDictionary class]]
        ? (json[@"installed_libraries"] ?: json[@"libraries"]) : nil;
    NSMutableArray *out = [NSMutableArray array];
    for (id entry in (libs ?: @[])) {
        if (![entry isKindOfClass:[NSDictionary class]]) continue;
        id lib = [entry[@"library"] isKindOfClass:[NSDictionary class]] ? entry[@"library"] : entry;
        NSString *name = strOr(lib[@"name"], nil);
        if (name == nil) continue;
        [out addObject:@{ @"name" : name, @"version" : strOr(lib[@"version"], @"") }];
    }
    return out;
}

- (NSArray<NSDictionary *> *)searchLibs:(NSString *)query {
    if (query.length == 0) return @[];
    id json = [self runJSON:@[ @"lib", @"search", query, @"--json" ] timeout:30];
    NSArray *libs = [json isKindOfClass:[NSDictionary class]] ? json[@"libraries"] : nil;
    NSMutableArray *out = [NSMutableArray array];
    for (id lib in (libs ?: @[])) {
        if (![lib isKindOfClass:[NSDictionary class]]) continue;
        NSString *name = strOr(lib[@"name"], nil);
        if (name == nil) continue;
        id latest = [lib[@"latest"] isKindOfClass:[NSDictionary class]] ? lib[@"latest"] : nil;
        [out addObject:@{
            @"name" : name,
            @"version" : strOr(latest[@"version"], @""),
            @"sentence" : strOr(latest[@"sentence"], @""),
        }];
        if (out.count >= 25) break;   // the index is huge; the UI shows a dozen
    }
    return out;
}

// ── sketchbook ──

- (NSArray<NSDictionary *> *)sketches {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *book = [NSHomeDirectory() stringByAppendingPathComponent:@"Documents/Arduino"];
    NSMutableArray *out = [NSMutableArray array];
    for (NSString *dir in [[fm contentsOfDirectoryAtPath:book error:nil]
             sortedArrayUsingSelector:@selector(localizedCaseInsensitiveCompare:)]) {
        if ([dir hasPrefix:@"."] || [dir isEqualToString:@"libraries"] ||
            [dir isEqualToString:@"hardware"]) continue;
        NSString *path = [book stringByAppendingPathComponent:dir];
        NSString *ino = [path stringByAppendingPathComponent:
                            [dir stringByAppendingPathExtension:@"ino"]];
        BOOL isDir = NO;
        if (![fm fileExistsAtPath:path isDirectory:&isDir] || !isDir) continue;
        if (![fm fileExistsAtPath:ino]) {
            // any .ino inside still counts
            BOOL any = NO;
            for (NSString *f in [fm contentsOfDirectoryAtPath:path error:nil]) {
                if ([f.pathExtension isEqualToString:@"ino"]) { any = YES; break; }
            }
            if (!any) continue;
        }
        [out addObject:@{ @"name" : dir, @"path" : path }];
    }
    return out;
}

// ── sketch editor ──

static BOOL isSourceFile(NSString *name) {
    static NSSet *exts;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        exts = [NSSet setWithArray:@[ @"ino", @"h", @"hpp", @"c", @"cpp", @"txt", @"md" ]];
    });
    return [exts containsObject:name.pathExtension.lowercaseString];
}

- (NSDictionary *)readSketch:(NSString *)dir {
    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL isDir = NO;
    NSString *std = dir.stringByStandardizingPath;
    if (![fm fileExistsAtPath:std isDirectory:&isDir] || !isDir) {
        return @{ @"ok" : @NO, @"error" : @"not a folder" };
    }
    NSMutableArray *files = [NSMutableArray array];
    for (NSString *f in [[fm contentsOfDirectoryAtPath:std error:nil]
             sortedArrayUsingSelector:@selector(localizedCaseInsensitiveCompare:)]) {
        if ([f hasPrefix:@"."] || !isSourceFile(f)) continue;
        NSString *p = [std stringByAppendingPathComponent:f];
        NSNumber *size = [fm attributesOfItemAtPath:p error:nil][NSFileSize];
        if (size.longLongValue > 2 * 1024 * 1024) continue;
        NSString *content = [NSString stringWithContentsOfFile:p
                                                      encoding:NSUTF8StringEncoding
                                                         error:nil];
        if (content == nil) continue;
        [files addObject:@{ @"name" : f, @"content" : content }];
    }
    // .ino files first, main sketch file at the very front
    NSString *main = [std.lastPathComponent stringByAppendingPathExtension:@"ino"];
    [files sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        int ra = [a[@"name"] isEqualToString:main] ? 0
            : [[a[@"name"] pathExtension] isEqualToString:@"ino"] ? 1 : 2;
        int rb = [b[@"name"] isEqualToString:main] ? 0
            : [[b[@"name"] pathExtension] isEqualToString:@"ino"] ? 1 : 2;
        if (ra != rb) return ra < rb ? NSOrderedAscending : NSOrderedDescending;
        return [a[@"name"] compare:b[@"name"]];
    }];
    _editRoot = std;
    return @{ @"ok" : @YES, @"files" : files };
}

- (NSDictionary *)writeFile:(NSString *)name content:(NSString *)content {
    if (_editRoot == nil) return @{ @"ok" : @NO, @"error" : @"no sketch open" };
    if (name == nil || content == nil || [name containsString:@"/"] ||
        [name containsString:@".."] || !isSourceFile(name)) {
        return @{ @"ok" : @NO, @"error" : @"bad name" };
    }
    NSString *p = [_editRoot stringByAppendingPathComponent:name];
    NSError *err = nil;
    if (![content writeToFile:p atomically:YES encoding:NSUTF8StringEncoding error:&err]) {
        return @{ @"ok" : @NO, @"error" : err.localizedDescription ?: @"write failed" };
    }
    return @{ @"ok" : @YES };
}

// ── serial ──

static speed_t baudConstant(int baud) {
    switch (baud) {
        case 300: return B300;
        case 1200: return B1200;
        case 2400: return B2400;
        case 4800: return B4800;
        case 9600: return B9600;
        case 19200: return B19200;
        case 38400: return B38400;
        case 57600: return B57600;
        case 115200: return B115200;
        case 230400: return B230400;
        default: return 0;
    }
}

- (NSDictionary *)serialOpen:(NSString *)port baud:(int)baud {
    [self serialClose];
    if (![port hasPrefix:@"/dev/cu."] && ![port hasPrefix:@"/dev/tty"]) {
        return @{ @"ok" : @NO, @"error" : @"bad port" };
    }
    int fd = open(port.UTF8String, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) {
        return @{ @"ok" : @NO,
                  @"error" : [NSString stringWithFormat:@"open failed (%s)", strerror(errno)] };
    }
    struct termios tio;
    if (tcgetattr(fd, &tio) == 0) {
        cfmakeraw(&tio);
        tio.c_cflag |= CLOCAL | CREAD;
        speed_t sp = baudConstant(baud);
        if (sp != 0) {
            cfsetispeed(&tio, sp);
            cfsetospeed(&tio, sp);
        }
        tcsetattr(fd, TCSANOW, &tio);
        if (sp == 0 && baud > 0) {
            // non-standard rate (e.g. 921600): IOSSIOSPEED-style, best effort
            speed_t custom = (speed_t)baud;
            ioctl(fd, 0x80045402 /* IOSSIOSPEED */, &custom);
        }
    }
    _serialFd = fd;
    __weak typeof(self) w = self;
    _serialSrc = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, fd, 0,
        dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_event_handler(_serialSrc, ^{
        typeof(self) s = w;
        if (s == nil) return;
        char buf[2048];
        ssize_t n = read(fd, buf, sizeof(buf));
        if (n > 0) {
            NSString *b64 = [[NSData dataWithBytes:buf length:(NSUInteger)n]
                                base64EncodedStringWithOptions:0];
            [s eval:[NSString stringWithFormat:
                @"window.OmniArduino && window.OmniArduino._serial(\"%@\")", b64]];
        } else if (n == 0 || (n < 0 && errno != EAGAIN)) {
            [s serialClose];
            [s eval:@"window.OmniArduino && window.OmniArduino._serialClosed()"];
        }
    });
    dispatch_source_set_cancel_handler(_serialSrc, ^{ close(fd); });
    dispatch_resume(_serialSrc);
    return @{ @"ok" : @YES };
}

- (void)serialClose {
    if (_serialSrc != nil) {
        dispatch_source_cancel(_serialSrc); // cancel handler closes the fd
        _serialSrc = nil;
        _serialFd = -1;
    }
}

- (BOOL)serialReset {
    if (_serialFd < 0) return NO;
    int dtr = TIOCM_DTR;
    int rts = TIOCM_RTS;
    ioctl(_serialFd, TIOCMBIC, &dtr);   // DTR low (keep IO0 high — normal boot)
    ioctl(_serialFd, TIOCMBIS, &rts);   // RTS asserted -> EN low
    usleep(100000);
    ioctl(_serialFd, TIOCMBIC, &rts);   // release EN -> board boots
    return YES;
}

- (BOOL)serialSend:(NSString *)text {
    if (_serialFd < 0 || text == nil) return NO;
    NSData *d = [text dataUsingEncoding:NSUTF8StringEncoding];
    return write(_serialFd, d.bytes, d.length) == (ssize_t)d.length;
}

@end
