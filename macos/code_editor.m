#import "code_editor.h"
#import <util.h>
#import <sys/ioctl.h>
#import <fcntl.h>
#import <signal.h>

// ── 파일 접근 ──

NSDictionary *CETree(NSString *path) {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSMutableArray *entries = [NSMutableArray array];
    for (NSString *name in [fm contentsOfDirectoryAtPath:path error:nil]) {
        if ([name hasPrefix:@"."]) continue;
        BOOL isDir = NO;
        NSString *p = [path stringByAppendingPathComponent:name];
        if (![fm fileExistsAtPath:p isDirectory:&isDir]) continue;
        [entries addObject:@{ @"name" : name, @"dir" : @(isDir) }];
    }
    [entries sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        BOOL da = [a[@"dir"] boolValue], db = [b[@"dir"] boolValue];
        if (da != db) return da ? NSOrderedAscending : NSOrderedDescending;
        return [a[@"name"] compare:b[@"name"]
                          options:NSCaseInsensitiveSearch];
    }];
    return @{ @"ok" : @YES, @"entries" : entries };
}

NSDictionary *CERead(NSString *path) {
    NSDictionary *attrs = [NSFileManager.defaultManager
        attributesOfItemAtPath:path error:nil];
    if (attrs == nil) return @{ @"ok" : @NO };
    if (attrs.fileSize > 5 * 1024 * 1024) {
        return @{ @"ok" : @NO, @"tooBig" : @YES };
    }
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (data == nil) return @{ @"ok" : @NO };
    // 앞부분에 NUL이 있으면 바이너리로 취급
    const char *bytes = data.bytes;
    NSUInteger probe = MIN(data.length, (NSUInteger)8192);
    for (NSUInteger i = 0; i < probe; i++) {
        if (bytes[i] == 0) return @{ @"ok" : @NO, @"binary" : @YES };
    }
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (text == nil) {
        text = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
    }
    if (text == nil) return @{ @"ok" : @NO, @"binary" : @YES };
    return @{ @"ok" : @YES, @"text" : text };
}

BOOL CEWrite(NSString *path, NSString *text) {
    return [text writeToFile:path atomically:YES
                    encoding:NSUTF8StringEncoding error:nil];
}

// ── PTY 터미널 매니저 ──

@interface OmniTermSession : NSObject
@property(nonatomic) int master;
@property(nonatomic) pid_t pid;
@property(nonatomic, strong) dispatch_source_t reader;
@end
@implementation OmniTermSession
@end

@implementation OmniTermManager {
    void (^_emit)(NSString *);
    NSMutableDictionary<NSNumber *, OmniTermSession *> *_sessions;
    NSInteger _nextTid;
}

- (instancetype)initWithEmit:(void (^)(NSString *))emit {
    if ((self = [super init])) {
        _emit = [emit copy];
        _sessions = [NSMutableDictionary dictionary];
        _nextTid = 1;
    }
    return self;
}

- (NSDictionary *)openWithCwd:(NSString *)cwd cols:(int)cols rows:(int)rows {
    struct winsize ws = {
        .ws_row = (unsigned short)MAX(4, rows),
        .ws_col = (unsigned short)MAX(20, cols),
    };
    int master = -1;
    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) return @{ @"ok" : @NO };
    if (pid == 0) {
        setenv("TERM", "xterm-256color", 1);
        setenv("LANG", "en_US.UTF-8", 1);
        setenv("COLORTERM", "truecolor", 1);
        if (cwd.length > 0) chdir(cwd.fileSystemRepresentation);
        execl("/bin/zsh", "-zsh", NULL);  // 로그인 셸 스타일 (rc 로드)
        _exit(1);
    }
    fcntl(master, F_SETFL, O_NONBLOCK);

    OmniTermSession *s = [OmniTermSession new];
    s.master = master;
    s.pid = pid;
    NSInteger tid = _nextTid++;

    dispatch_source_t src = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_READ, master, 0,
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    __weak OmniTermManager *weakSelf = self;
    dispatch_source_set_event_handler(src, ^{
        char buf[16384];
        ssize_t n = read(master, buf, sizeof(buf));
        OmniTermManager *strongSelf = weakSelf;
        if (strongSelf == nil) return;
        if (n > 0) {
            NSData *chunk = [NSData dataWithBytes:buf length:n];
            NSString *js = [NSString stringWithFormat:
                @"window.OmniCE && OmniCE._data(%ld, '%@')",
                (long)tid, [chunk base64EncodedStringWithOptions:0]];
            strongSelf->_emit(js);
        } else if (n == 0 || (n < 0 && errno != EAGAIN)) {
            [strongSelf closeTid:tid];
            strongSelf->_emit([NSString stringWithFormat:
                @"window.OmniCE && OmniCE._exit(%ld)", (long)tid]);
        }
    });
    s.reader = src;
    @synchronized(self) {
        _sessions[@(tid)] = s;
    }
    dispatch_resume(src);
    return @{ @"ok" : @YES, @"tid" : @(tid) };
}

- (BOOL)writeTid:(NSInteger)tid data:(NSData *)data {
    OmniTermSession *s;
    @synchronized(self) { s = _sessions[@(tid)]; }
    if (s == nil || data.length == 0) return NO;
    return write(s.master, data.bytes, data.length) >= 0;
}

- (BOOL)resizeTid:(NSInteger)tid cols:(int)cols rows:(int)rows {
    OmniTermSession *s;
    @synchronized(self) { s = _sessions[@(tid)]; }
    if (s == nil) return NO;
    struct winsize ws = {
        .ws_row = (unsigned short)MAX(4, rows),
        .ws_col = (unsigned short)MAX(20, cols),
    };
    return ioctl(s.master, TIOCSWINSZ, &ws) == 0;
}

- (void)closeTid:(NSInteger)tid {
    OmniTermSession *s;
    @synchronized(self) {
        s = _sessions[@(tid)];
        [_sessions removeObjectForKey:@(tid)];
    }
    if (s == nil) return;
    if (s.reader != nil) dispatch_source_cancel(s.reader);
    kill(s.pid, SIGHUP);
    close(s.master);
}

- (void)closeAll {
    NSArray *tids;
    @synchronized(self) { tids = _sessions.allKeys.copy; }
    for (NSNumber *t in tids) [self closeTid:t.integerValue];
}

@end
