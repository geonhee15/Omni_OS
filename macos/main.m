#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <signal.h>
#import "sp1_status.h"
#import "sysmon.h"
#import "code_editor.h"
#import "omni_ai.h"
#import <sqlite3.h>
#import <CommonCrypto/CommonDigest.h>

// ── 오너 잠금 ──
// 소스는 공개돼 있지만 이 앱은 개인용이다. 레포에 포함되지 않는 키 파일
// (~/.omni/owner.key)의 SHA-256이 아래 해시와 일치해야만 부팅한다.
// 해시는 공개돼도 키를 역산할 수 없고(256비트 랜덤), 키 파일은 오너의
// 기기에만 존재한다. 클론+빌드만으로는 실행되지 않는다.
static NSString *const kOwnerKeyHash =
    @"28016bfbe5e0182ec476aee96fd0f560f9bab63a605c22ce929f438872ef4795";

static BOOL OmniOwnerAuthorized(void) {
    NSString *path = [NSHomeDirectory() stringByAppendingPathComponent:@".omni/owner.key"];
    NSString *raw = [NSString stringWithContentsOfFile:path
                                              encoding:NSUTF8StringEncoding
                                                 error:nil];
    if (raw == nil) return NO;
    NSString *key = [raw stringByTrimmingCharactersInSet:
        NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSData *d = [key dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char h[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(d.bytes, (CC_LONG)d.length, h);
    NSMutableString *hex = [NSMutableString stringWithCapacity:64];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
        [hex appendFormat:@"%02x", h[i]];
    }
    return [hex isEqualToString:kOwnerKeyHash];
}
#import "arduino_bridge.h"

// SP-1 watcher pause/resume lives in sp1_status.m (SP1PauseWatcher /
// SP1ResumeWatcher). Resume is also called unconditionally on app exit so
// the security watcher is never left stopped.

// Serves bundle Resources/web/* over omni://local/... — unlike bare file://,
// a custom scheme gives the page a real origin, so fetch()/XHR work and the
// Human/TensorFlow.js model loader can pull its model files.
@interface OmniSchemeHandler : NSObject <WKURLSchemeHandler>
// CODE EDITOR가 열어둔 폴더들 — 이 안의 미디어 파일만 /__media__로 서빙
@property (strong) NSMutableSet<NSString *> *mediaRoots;
@end

@implementation OmniSchemeHandler

- (instancetype)init {
    if ((self = [super init])) {
        _mediaRoots = [NSMutableSet set];
    }
    return self;
}

static NSString *MediaMime(NSString *ext) {
    static NSDictionary *map;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        map = @{
            @"png" : @"image/png", @"jpg" : @"image/jpeg", @"jpeg" : @"image/jpeg",
            @"gif" : @"image/gif", @"webp" : @"image/webp", @"bmp" : @"image/bmp",
            @"svg" : @"image/svg+xml", @"ico" : @"image/x-icon",
            @"mp3" : @"audio/mpeg", @"wav" : @"audio/wav", @"m4a" : @"audio/mp4",
            @"aac" : @"audio/aac", @"flac" : @"audio/flac", @"ogg" : @"audio/ogg",
            @"mp4" : @"video/mp4", @"mov" : @"video/quicktime",
            @"m4v" : @"video/x-m4v", @"webm" : @"video/webm",
        };
    });
    return map[ext.lowercaseString] ?: @"application/octet-stream";
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    NSString *path = url.path.length ? url.path : @"/index.html";
    if ([path isEqualToString:@"/"]) path = @"/index.html";

    // 로컬 미디어 뷰어: omni://local/__media__?p=<절대경로> (열어둔 폴더 한정)
    if ([path isEqualToString:@"/__media__"]) {
        NSURLComponents *comps = [NSURLComponents componentsWithURL:url
                                            resolvingAgainstBaseURL:NO];
        NSString *req = nil;
        for (NSURLQueryItem *q in comps.queryItems) {
            if ([q.name isEqualToString:@"p"]) req = q.value;
        }
        NSString *std = req.stringByStandardizingPath;
        BOOL inside = NO;
        for (NSString *root in self.mediaRoots) {
            if ([std hasPrefix:[root stringByAppendingString:@"/"]]) { inside = YES; break; }
        }
        NSData *media = inside ? [NSData dataWithContentsOfFile:std] : nil;
        if (media == nil) {
            [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain
                                                       code:NSURLErrorFileDoesNotExist
                                                   userInfo:nil]];
            return;
        }
        NSHTTPURLResponse *resp = [[NSHTTPURLResponse alloc]
             initWithURL:url
              statusCode:200
             HTTPVersion:@"HTTP/1.1"
            headerFields:@{
                @"Content-Type" : MediaMime(std.pathExtension),
                @"Content-Length" : [NSString stringWithFormat:@"%lu",
                                     (unsigned long)media.length],
            }];
        [task didReceiveResponse:resp];
        [task didReceiveData:media];
        [task didFinish];
        return;
    }

    NSString *webRoot = [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"web"];
    NSString *filePath = [[webRoot stringByAppendingPathComponent:path] stringByStandardizingPath];
    NSData *data = [filePath hasPrefix:webRoot] ? [NSData dataWithContentsOfFile:filePath] : nil;
    if (data == nil) {
        [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain
                                                   code:NSURLErrorFileDoesNotExist
                                               userInfo:nil]];
        return;
    }

    static NSDictionary<NSString *, NSString *> *mimes;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        mimes = @{
            @"html" : @"text/html", @"css" : @"text/css",
            @"js" : @"application/javascript", @"mjs" : @"application/javascript",
            @"json" : @"application/json",
            @"bin" : @"application/octet-stream", @"task" : @"application/octet-stream",
            @"wasm" : @"application/wasm",
            @"jpg" : @"image/jpeg", @"png" : @"image/png", @"svg" : @"image/svg+xml",
        };
    });
    NSString *mime = mimes[filePath.pathExtension.lowercaseString] ?: @"application/octet-stream";
    NSHTTPURLResponse *resp = [[NSHTTPURLResponse alloc]
         initWithURL:url
          statusCode:200
         HTTPVersion:@"HTTP/1.1"
        headerFields:@{
            @"Content-Type" : mime,
            @"Content-Length" : [NSString stringWithFormat:@"%lu", (unsigned long)data.length],
            @"Access-Control-Allow-Origin" : @"*",
        }];
    [task didReceiveResponse:resp];
    [task didReceiveData:data];
    [task didFinish];
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
}

@end

// 앱 데이터 베이스 폴더: 개발 체크아웃이 있으면 그 안, 없으면 ~/Documents/OmniOS
static NSString *OmniBaseDir(void) {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *dev = [NSHomeDirectory()
        stringByAppendingPathComponent:@"Desktop/Important/Omni_OS"];
    BOOL isDir = NO;
    if ([fm fileExistsAtPath:dev isDirectory:&isDir] && isDir) return dev;
    return [[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES)
               firstObject] stringByAppendingPathComponent:@"OmniOS"];
}

// PLY exports accumulate in <project>/ARC-SCAN-SAVES (falls back to
// ~/Documents/OmniOS/ARC-SCAN-SAVES when the dev checkout is absent)
static NSString *ArcSavesDir(void) {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *dev = [NSHomeDirectory()
        stringByAppendingPathComponent:@"Desktop/Important/Omni_OS"];
    BOOL isDir = NO;
    NSString *base = ([fm fileExistsAtPath:dev isDirectory:&isDir] && isDir)
        ? dev
        : [[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES)
               firstObject] stringByAppendingPathComponent:@"OmniOS"];
    NSString *dir = [base stringByAppendingPathComponent:@"ARC-SCAN-SAVES"];
    [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    return dir;
}

@interface AppDelegate : NSObject <NSApplicationDelegate, WKScriptMessageHandler, WKUIDelegate>
@property (strong) NSWindow *window;
@property (strong) WKWebView *webView;
@property (strong) OmniSchemeHandler *schemeHandler;
@property (strong) NSURLSessionWebSocketTask *arcTask;
@property (strong) ArduinoBridge *arduino;
@property (strong) OmniTermManager *terms;
@property (strong) NSTask *voiceLiveTask;
@property (strong) NSPipe *voiceLiveIn;
@property (strong) NSMutableSet<NSString *> *ceRoots; // CODE EDITOR가 열어둔 폴더들
@property (strong) OmniAIListener *aiListener;        // OMNI_AI 음성 인식
// OMNI_AI 신경망 TTS 변환 데몬 (worker.py ttsserve)
@property (strong) NSTask *aiTtsTask;
@property (strong) NSPipe *aiTtsIn;
@property (assign) BOOL aiTtsReady;
@property (strong) NSMutableString *aiTtsBuf;
@property (strong) NSMutableArray *aiTtsWaiters;      // (^)(BOOL ready) 블록들
@property (strong) NSNumber *aiTtsPendingId;          // 진행 중 요청의 msgId
@property (strong) NSString *aiTtsPendingIn;
@property (strong) NSString *aiTtsPendingOut;
// OMNI_AI 리얼타임 음성 세션 (gpt-realtime WSS 릴레이 — 키는 네이티브에만)
@property (strong) NSURLSessionWebSocketTask *aiRtTask;
// OMNI_AI 외국어 음색 데몬 (seed_serve.py — Seed-VC 상주)
@property (strong) NSTask *aiSeedTask;
@property (strong) NSPipe *aiSeedIn;
@property (assign) BOOL aiSeedReady;
@property (strong) NSMutableString *aiSeedBuf;
@property (strong) NSMutableArray *aiSeedWaiters;
@property (strong) NSNumber *aiSeedPendingId;
@property (strong) NSString *aiSeedPendingIn;
@property (strong) NSString *aiSeedPendingOut;
@end

@implementation AppDelegate

- (void)showAccessDeniedAndQuit {
    NSWindow *w = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 560, 200)
                  styleMask:NSWindowStyleMaskTitled
                    backing:NSBackingStoreBuffered
                      defer:NO];
    w.title = @"OMNI_OS";
    w.backgroundColor = [NSColor colorWithRed:0.008 green:0.03 blue:0.075 alpha:1.0];
    NSTextField *label = [NSTextField wrappingLabelWithString:
        @"\u2298  ACCESS DENIED\n\n"
        @"OWNER KEY NOT FOUND (~/.omni/owner.key)\n"
        @"THIS IS A PERSONAL BUILD — OMNI_OS REFUSES TO START\n"
        @"ON UNAUTHORIZED DEVICES."];
    label.font = [NSFont monospacedSystemFontOfSize:13 weight:NSFontWeightSemibold];
    label.textColor = [NSColor colorWithRed:0.21 green:0.84 blue:1.0 alpha:1.0];
    label.alignment = NSTextAlignmentCenter;
    label.frame = NSMakeRect(20, 20, 520, 160);
    [w.contentView addSubview:label];
    [w center];
    [w makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(6 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        [NSApp terminate:nil];
    });
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    if (!OmniOwnerAuthorized()) {
        [self showAccessDeniedAndQuit];
        return;
    }
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 1100, 720)
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    window.title = @"OMNI_OS";
    // Same color as the web UI's --bg-deep (#020813) so the titlebar blends in.
    window.backgroundColor = [NSColor colorWithSRGBRed:0x02 / 255.0
                                                 green:0x08 / 255.0
                                                  blue:0x13 / 255.0
                                                 alpha:1.0];
    window.minSize = NSMakeSize(760, 520);
    [window center];

    // JS calls window.webkit.messageHandlers.omni.postMessage({id, cmd})
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    [config.userContentController addScriptMessageHandler:self name:@"omni"];
    self.schemeHandler = [OmniSchemeHandler new];
    self.ceRoots = self.schemeHandler.mediaRoots; // ce.* 검증과 미디어 서빙이 같은 집합
    [config setURLSchemeHandler:self.schemeHandler forURLScheme:@"omni"];

    WKWebView *webView = [[WKWebView alloc] initWithFrame:window.contentView.bounds
                                            configuration:config];
    webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    webView.UIDelegate = self; // <input type="file"> needs runOpenPanel below
    [webView setValue:@NO forKey:@"drawsBackground"];

    NSString *indexPath = [[NSBundle mainBundle].resourcePath
        stringByAppendingPathComponent:@"web/index.html"];
    if (![[NSFileManager defaultManager] fileExistsAtPath:indexPath]) {
        NSLog(@"web/index.html not found in app bundle");
        [NSApp terminate:nil];
        return;
    }
    [webView loadRequest:[NSURLRequest requestWithURL:
        [NSURL URLWithString:@"omni://local/index.html"]]];

    [window.contentView addSubview:webView];
    [window makeKeyAndOrderFront:nil];
    self.window = window;
    self.webView = webView;
    self.arduino = [[ArduinoBridge alloc] initWithWebView:webView];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.voiceLiveTask != nil) [self.voiceLiveTask terminate];
    if (self.aiTtsTask != nil) [self.aiTtsTask terminate];
    if (self.aiSeedTask != nil) [self.aiSeedTask terminate];
    [self.aiRtTask cancel];
    [self.aiListener cancel];
    [self.terms closeAll]; // 좀비 zsh 방지
    SP1ResumeWatcher();
}

// CODE EDITOR: 경로가 열어둔 폴더 안인지 검증
- (NSString *)ceValidatePath:(NSString *)path {
    NSString *std = path.stringByStandardizingPath;
    if (std == nil) return nil;
    for (NSString *root in self.ceRoots) {
        if ([std isEqualToString:root]
            || [std hasPrefix:[root stringByAppendingString:@"/"]]) {
            return std;
        }
    }
    return nil;
}

// grant camera access for hand-gesture control (macOS still shows its own
// system-level camera permission prompt for the app on first use)
- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
                          initiatedByFrame:(WKFrameInfo *)frame
                                      type:(WKMediaCaptureType)type
                           decisionHandler:(void (^)(WKPermissionDecision))decisionHandler
    API_AVAILABLE(macos(12.0)) {
    decisionHandler(WKPermissionDecisionGrant);
}

// ---- file picker for <input type="file"> ----

- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
              initiatedByFrame:(WKFrameInfo *)frame
             completionHandler:(void (^)(NSArray<NSURL *> *URLs))completionHandler {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        completionHandler(result == NSModalResponseOK ? panel.URLs : nil);
    }];
}

// ---- Arduino IDE panel ----

- (void)handleArduino:(NSString *)cmd arg:(NSString *)arg msgId:(NSNumber *)msgId {
    NSDictionary *a = nil;
    if (arg != nil) {
        NSData *d = [arg dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = d ? [NSJSONSerialization JSONObjectWithData:d options:0 error:nil] : nil;
        if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
    }
    if ([cmd isEqualToString:@"arduino.env"]) {
        NSString *cli = [ArduinoBridge cliPath];
        [self deliverPayload:@{ @"cli" : cli ?: [NSNull null] } forId:msgId];
    } else if ([cmd isEqualToString:@"arduino.run"]) {
        NSArray *args = [a[@"args"] isKindOfClass:[NSArray class]] ? a[@"args"] : nil;
        BOOL ok = NO;
        if (args != nil) {
            NSMutableArray<NSString *> *clean = [NSMutableArray array];
            for (id x in args) {
                if ([x isKindOfClass:[NSString class]]) [clean addObject:x];
            }
            ok = [self.arduino runJob:clean];
        }
        [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
    } else if ([cmd isEqualToString:@"arduino.cancel"]) {
        [self.arduino cancelJob];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
    } else if ([cmd isEqualToString:@"arduino.ports"]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self deliverPayload:@{ @"ports" : [self.arduino listPorts] } forId:msgId];
        });
    } else if ([cmd isEqualToString:@"arduino.boards"]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self deliverPayload:@{ @"boards" : [self.arduino listBoards] } forId:msgId];
        });
    } else if ([cmd isEqualToString:@"arduino.libList"]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self deliverPayload:@{ @"libs" : [self.arduino listInstalledLibs] } forId:msgId];
        });
    } else if ([cmd isEqualToString:@"arduino.libSearch"]) {
        NSString *q = [a[@"q"] isKindOfClass:[NSString class]] ? a[@"q"] : @"";
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self deliverPayload:@{ @"libs" : [self.arduino searchLibs:q] } forId:msgId];
        });
    } else if ([cmd isEqualToString:@"arduino.sketches"]) {
        [self deliverPayload:@{ @"sketches" : [self.arduino sketches] } forId:msgId];
    } else if ([cmd isEqualToString:@"arduino.readSketch"]) {
        NSString *dir = [a[@"dir"] isKindOfClass:[NSString class]] ? a[@"dir"] : nil;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self deliverPayload:(dir ? [self.arduino readSketch:dir]
                                      : @{ @"ok" : @NO }) forId:msgId];
        });
    } else if ([cmd isEqualToString:@"arduino.writeFile"]) {
        NSString *name = [a[@"name"] isKindOfClass:[NSString class]] ? a[@"name"] : nil;
        NSString *content = [a[@"content"] isKindOfClass:[NSString class]] ? a[@"content"] : nil;
        [self deliverPayload:[self.arduino writeFile:name content:content] forId:msgId];
    } else if ([cmd isEqualToString:@"arduino.pickSketch"]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSOpenPanel *panel = [NSOpenPanel openPanel];
            panel.canChooseFiles = YES;
            panel.canChooseDirectories = YES;
            panel.allowsMultipleSelection = NO;
            panel.message = @"Choose a sketch (.ino) or its folder";
            [panel beginSheetModalForWindow:self.window
                          completionHandler:^(NSModalResponse result) {
                NSString *path = (result == NSModalResponseOK && panel.URLs.count > 0)
                    ? panel.URLs.firstObject.path : nil;
                [self deliverPayload:@{ @"path" : path ?: [NSNull null] } forId:msgId];
            }];
        });
    } else if ([cmd isEqualToString:@"arduino.serialOpen"]) {
        NSString *port = [a[@"port"] isKindOfClass:[NSString class]] ? a[@"port"] : nil;
        int baud = [a[@"baud"] isKindOfClass:[NSNumber class]] ? [a[@"baud"] intValue] : 115200;
        NSDictionary *r = port ? [self.arduino serialOpen:port baud:baud]
                               : @{ @"ok" : @NO, @"error" : @"no port" };
        [self deliverPayload:r forId:msgId];
    } else if ([cmd isEqualToString:@"arduino.serialClose"]) {
        [self.arduino serialClose];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
    } else if ([cmd isEqualToString:@"arduino.serialReset"]) {
        [self deliverPayload:@{ @"ok" : @([self.arduino serialReset]) } forId:msgId];
    } else if ([cmd isEqualToString:@"arduino.serialSend"]) {
        NSString *data = [a[@"data"] isKindOfClass:[NSString class]] ? a[@"data"] : nil;
        [self deliverPayload:@{ @"ok" : @([self.arduino serialSend:data]) } forId:msgId];
    }
}

// ---- ARC-SCAN websocket relay ----

- (void)arcEvalJS:(NSString *)js {
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.webView evaluateJavaScript:js completionHandler:nil];
    });
}

- (void)arcReceiveLoop:(NSURLSessionWebSocketTask *)task {
    __weak typeof(self) weakSelf = self;
    [task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *msg, NSError *error) {
        typeof(self) strongSelf = weakSelf;
        if (strongSelf == nil || task != strongSelf.arcTask) return; // superseded
        if (error != nil) {
            [strongSelf arcEvalJS:@"window.OmniArc && window.OmniArc._state(\"closed\")"];
            return;
        }
        if (msg.type == NSURLSessionWebSocketMessageTypeString && msg.string != nil) {
            // re-serialize through NSJSONSerialization so device data can never
            // inject script into the evaluateJavaScript call
            NSData *raw = [msg.string dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = raw ? [NSJSONSerialization JSONObjectWithData:raw options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) {
                NSData *safe = [NSJSONSerialization dataWithJSONObject:parsed options:0 error:nil];
                NSString *s = [[NSString alloc] initWithData:safe encoding:NSUTF8StringEncoding];
                if (s != nil) {
                    [strongSelf arcEvalJS:
                        [NSString stringWithFormat:@"window.OmniArc && window.OmniArc._msg(%@)", s]];
                }
            }
        }
        [strongSelf arcReceiveLoop:task];
    }];
}

// ---- native bridge ----

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    NSDictionary *body = [message.body isKindOfClass:[NSDictionary class]] ? message.body : nil;
    NSNumber *msgId = [body[@"id"] isKindOfClass:[NSNumber class]] ? body[@"id"] : nil;
    NSString *cmd = [body[@"cmd"] isKindOfClass:[NSString class]] ? body[@"cmd"] : nil;
    NSString *arg = [body[@"arg"] isKindOfClass:[NSString class]] ? body[@"arg"] : nil;
    if (msgId == nil || cmd == nil) return;

    if ([cmd isEqualToString:@"voice.status"]) {
        // 신경망 엔진 설치 여부 (파일 검사 — 빠름)
        NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
        NSFileManager *fm = NSFileManager.defaultManager;
        BOOL venv = [fm isExecutableFileAtPath:
            [eng stringByAppendingPathComponent:@"venv/bin/python"]];
        BOOL worker = [fm fileExistsAtPath:
            [eng stringByAppendingPathComponent:@"worker.py"]];
        NSString *cache = [NSHomeDirectory()
            stringByAppendingPathComponent:@".cache/torch/hub/checkpoints/WavLM-Large.pt"];
        [self deliverPayload:@{ @"ok" : @YES,
                                @"installed" : @(venv && worker),
                                @"models" : @([fm fileExistsAtPath:cache]),
                                @"dir" : eng } forId:msgId];
    } else if ([cmd isEqualToString:@"voice.setup"]) {
        // 엔진 설치 — 출력 라인을 OmniVC._log 로 스트리밍
        NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:@"/bin/zsh"];
        task.arguments = @[ [eng stringByAppendingPathComponent:@"setup.sh"] ];
        NSPipe *pipe = [NSPipe pipe];
        task.standardOutput = pipe;
        task.standardError = pipe;
        __weak AppDelegate *weakSelf = self;
        pipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *fh) {
            NSData *d = fh.availableData;
            if (d.length == 0) return;
            NSString *js = [NSString stringWithFormat:
                @"window.OmniVC && OmniVC._log('%@')",
                [d base64EncodedStringWithOptions:0]];
            dispatch_async(dispatch_get_main_queue(), ^{
                [weakSelf.webView evaluateJavaScript:js completionHandler:nil];
            });
        };
        task.terminationHandler = ^(NSTask *t) {
            pipe.fileHandleForReading.readabilityHandler = nil;
            NSString *js = [NSString stringWithFormat:
                @"window.OmniVC && OmniVC._done(%d)", t.terminationStatus];
            dispatch_async(dispatch_get_main_queue(), ^{
                [weakSelf.webView evaluateJavaScript:js completionHandler:nil];
            });
        };
        NSError *err = nil;
        BOOL ok = [task launchAndReturnError:&err];
        [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
    } else if ([cmd isEqualToString:@"voice.exec"]) {
        // 워커 실행 (learn/convert/status) — 완료 시 stdout JSON 반환
        NSDictionary *a = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
        }
        NSArray *args = [a[@"args"] isKindOfClass:[NSArray class]] ? a[@"args"] : @[];
        NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            NSTask *task = [[NSTask alloc] init];
            task.executableURL = [NSURL fileURLWithPath:
                [eng stringByAppendingPathComponent:@"venv/bin/python"]];
            task.arguments = [@[ [eng stringByAppendingPathComponent:@"worker.py"] ]
                arrayByAddingObjectsFromArray:args];
            NSPipe *outPipe = [NSPipe pipe];
            NSPipe *errPipe = [NSPipe pipe];
            task.standardOutput = outPipe;
            task.standardError = errPipe;
            NSError *err = nil;
            if (![task launchAndReturnError:&err]) {
                [self deliverPayload:@{ @"ok" : @NO,
                    @"error" : err.localizedDescription ?: @"launch failed" }
                               forId:msgId];
                return;
            }
            NSData *outData = [outPipe.fileHandleForReading readDataToEndOfFile];
            NSData *errData = [errPipe.fileHandleForReading readDataToEndOfFile];
            [task waitUntilExit];
            NSString *outStr = [[NSString alloc] initWithData:outData
                encoding:NSUTF8StringEncoding] ?: @"";
            // 마지막 JSON 라인 파싱 (torch 경고 등이 섞여도 견디게)
            NSDictionary *result = nil;
            for (NSString *line in [[outStr componentsSeparatedByString:@"\n"]
                                    reverseObjectEnumerator]) {
                if (![line hasPrefix:@"{"]) continue;
                NSData *ld = [line dataUsingEncoding:NSUTF8StringEncoding];
                id p = [NSJSONSerialization JSONObjectWithData:ld options:0 error:nil];
                if ([p isKindOfClass:[NSDictionary class]]) { result = p; break; }
            }
            if (result != nil) {
                [self deliverPayload:result forId:msgId];
            } else {
                NSString *errStr = [[NSString alloc] initWithData:errData
                    encoding:NSUTF8StringEncoding] ?: @"";
                NSString *tail = errStr.length > 600
                    ? [errStr substringFromIndex:errStr.length - 600] : errStr;
                [self deliverPayload:@{ @"ok" : @NO, @"error" : tail } forId:msgId];
            }
        });
    } else if ([cmd isEqualToString:@"voice.ultra"]) {
        // ULTRA 엔진 (Seed-VC): 확산 기반 zero-shot 변환 — 완료 후 출력 wav 경로 반환
        NSDictionary *a = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
        }
        NSString *source = [a[@"source"] isKindOfClass:[NSString class]] ? a[@"source"] : nil;
        NSString *ref = [a[@"ref"] isKindOfClass:[NSString class]] ? a[@"ref"] : nil;
        NSString *outDir = [a[@"outDir"] isKindOfClass:[NSString class]] ? a[@"outDir"] : nil;
        int steps = [a[@"steps"] intValue] ?: 25;
        NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
        NSString *py = [eng stringByAppendingPathComponent:@"seedvc/venv/bin/python"];
        if (source == nil || ref == nil || outDir == nil
            || ![NSFileManager.defaultManager isExecutableFileAtPath:py]) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"ultra engine not installed" }
                           forId:msgId];
            return;
        }
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            [NSFileManager.defaultManager createDirectoryAtPath:outDir
                withIntermediateDirectories:YES attributes:nil error:nil];
            NSTask *task = [[NSTask alloc] init];
            task.executableURL = [NSURL fileURLWithPath:py];
            BOOL f0 = a[@"f0"] == nil ? YES : [a[@"f0"] boolValue];
            double cfg = a[@"cfg"] != nil ? [a[@"cfg"] doubleValue] : 0.3;
            NSMutableArray *ta = [@[
                [eng stringByAppendingPathComponent:@"seed_infer.py"],
                @"--source", source, @"--target", ref, @"--output", outDir,
                @"--diffusion-steps", [NSString stringWithFormat:@"%d", steps],
                @"--inference-cfg-rate", [NSString stringWithFormat:@"%.2f", cfg],
                @"--fp16", @"False" ] mutableCopy];
            if (f0) {
                // F0 조건 모델: 소스 피치 윤곽을 그대로 따라가 워블(오토튠 언덕) 제거
                [ta addObjectsFromArray:@[ @"--f0-condition", @"True",
                                           @"--auto-f0-adjust", @"True" ]];
            }
            task.arguments = ta;
            NSPipe *errPipe = [NSPipe pipe];
            task.standardOutput = [NSPipe pipe];
            task.standardError = errPipe;
            NSError *err = nil;
            if (![task launchAndReturnError:&err]) {
                [self deliverPayload:@{ @"ok" : @NO,
                    @"error" : err.localizedDescription ?: @"launch failed" } forId:msgId];
                return;
            }
            NSData *errData = [errPipe.fileHandleForReading readDataToEndOfFile];
            [task waitUntilExit];
            NSString *found = nil;
            for (NSString *f in [NSFileManager.defaultManager
                                 contentsOfDirectoryAtPath:outDir error:nil]) {
                if ([f.pathExtension.lowercaseString isEqualToString:@"wav"]) {
                    found = [outDir stringByAppendingPathComponent:f];
                }
            }
            if (task.terminationStatus == 0 && found != nil) {
                [self deliverPayload:@{ @"ok" : @YES, @"path" : found } forId:msgId];
            } else {
                NSString *errStr = [[NSString alloc] initWithData:errData
                    encoding:NSUTF8StringEncoding] ?: @"";
                NSString *tail = errStr.length > 500
                    ? [errStr substringFromIndex:errStr.length - 500] : errStr;
                [self deliverPayload:@{ @"ok" : @NO, @"error" : tail } forId:msgId];
            }
        });
    } else if ([cmd isEqualToString:@"voice.ultraStatus"]) {
        NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
        BOOL ok = [NSFileManager.defaultManager isExecutableFileAtPath:
            [eng stringByAppendingPathComponent:@"seedvc/venv/bin/python"]];
        [self deliverPayload:@{ @"ok" : @YES, @"installed" : @(ok) } forId:msgId];
    } else if ([cmd isEqualToString:@"voice.liveStart"]) {
        // 신경망 라이브 데몬 기동 — stdout 라인을 OmniVC._live/_liveState 로 푸시
        NSDictionary *a = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
        }
        NSString *profile = [a[@"profile"] isKindOfClass:[NSString class]] ? a[@"profile"] : nil;
        if (self.voiceLiveTask != nil) {
            [self.voiceLiveTask terminate];
            self.voiceLiveTask = nil;
            self.voiceLiveIn = nil;
        }
        NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:
            [eng stringByAppendingPathComponent:@"venv/bin/python"]];
        task.arguments = @[ [eng stringByAppendingPathComponent:@"worker.py"],
                            @"serve", profile ?: @"" ];
        NSPipe *inPipe = [NSPipe pipe];
        NSPipe *outPipe = [NSPipe pipe];
        task.standardInput = inPipe;
        task.standardOutput = outPipe;
        task.standardError = [NSPipe pipe];
        __weak AppDelegate *weakSelf = self;
        __block NSMutableData *lineBuf = [NSMutableData data];
        outPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *fh) {
            NSData *d = fh.availableData;
            if (d.length == 0) return;
            [lineBuf appendData:d];
            // 개행 단위로 분리해 JS로 전달 (b64 오디오 또는 READY/ERR)
            while (YES) {
                NSRange nl = [lineBuf rangeOfData:[NSData dataWithBytes:"\n" length:1]
                                          options:0
                                            range:NSMakeRange(0, lineBuf.length)];
                if (nl.location == NSNotFound) break;
                NSData *lineData = [lineBuf subdataWithRange:NSMakeRange(0, nl.location)];
                [lineBuf replaceBytesInRange:NSMakeRange(0, nl.location + 1)
                                   withBytes:NULL length:0];
                NSString *line = [[NSString alloc] initWithData:lineData
                    encoding:NSUTF8StringEncoding] ?: @"";
                NSString *js;
                if ([line isEqualToString:@"READY"] || [line hasPrefix:@"ERR"]) {
                    NSData *lj = [NSJSONSerialization dataWithJSONObject:@[ line ]
                        options:0 error:nil];
                    NSString *encoded = [[NSString alloc] initWithData:lj
                        encoding:NSUTF8StringEncoding];
                    js = [NSString stringWithFormat:
                        @"window.OmniVC && OmniVC._liveState(%@[0])", encoded];
                } else {
                    js = [NSString stringWithFormat:
                        @"window.OmniVC && OmniVC._live('%@')", line];
                }
                dispatch_async(dispatch_get_main_queue(), ^{
                    [weakSelf.webView evaluateJavaScript:js completionHandler:nil];
                });
            }
        };
        task.terminationHandler = ^(NSTask *t) {
            outPipe.fileHandleForReading.readabilityHandler = nil;
            dispatch_async(dispatch_get_main_queue(), ^{
                [weakSelf.webView evaluateJavaScript:
                    @"window.OmniVC && OmniVC._liveState('EXITED')"
                    completionHandler:nil];
            });
        };
        NSError *err = nil;
        BOOL ok = [task launchAndReturnError:&err];
        if (ok) {
            self.voiceLiveTask = task;
            self.voiceLiveIn = inPipe;
        }
        [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
    } else if ([cmd isEqualToString:@"voice.liveFeed"]) {
        // float32 PCM 청크(base64) → 4바이트 길이 프리픽스 붙여 데몬 stdin으로
        NSDictionary *a = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
        }
        NSString *b64 = [a[@"data"] isKindOfClass:[NSString class]] ? a[@"data"] : nil;
        NSData *pcm = b64 ? [[NSData alloc] initWithBase64EncodedString:b64 options:0] : nil;
        BOOL ok = NO;
        if (pcm != nil && self.voiceLiveIn != nil) {
            uint32_t len = (uint32_t)pcm.length;
            NSMutableData *frame = [NSMutableData dataWithBytes:&len length:4];
            [frame appendData:pcm];
            @try {
                [self.voiceLiveIn.fileHandleForWriting writeData:frame];
                ok = YES;
            } @catch (NSException *e) {}
        }
        [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
    } else if ([cmd isEqualToString:@"voice.liveStop"]) {
        if (self.voiceLiveIn != nil) {
            uint32_t zero = 0;
            @try {
                [self.voiceLiveIn.fileHandleForWriting
                    writeData:[NSData dataWithBytes:&zero length:4]];
            } @catch (NSException *e) {}
        }
        if (self.voiceLiveTask != nil) [self.voiceLiveTask terminate];
        self.voiceLiveTask = nil;
        self.voiceLiveIn = nil;
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
    } else if ([cmd isEqualToString:@"voice.dir"]) {
        // 음성 산출물 폴더 (Omni_OS/Voice) 생성 + 쓰기 루트 등록
        if (self.ceRoots == nil) self.ceRoots = [NSMutableSet set];
        NSString *dir = [OmniBaseDir() stringByAppendingPathComponent:@"Voice"];
        [NSFileManager.defaultManager createDirectoryAtPath:dir
            withIntermediateDirectories:YES attributes:nil error:nil];
        [self.ceRoots addObject:dir.stringByStandardizingPath];
        [self deliverPayload:@{ @"ok" : @YES, @"path" : dir } forId:msgId];
    } else if ([cmd isEqualToString:@"proj.scaffold"] || [cmd isEqualToString:@"notes.vault"]) {
        // 프로젝트 폴더 골격 생성 / 기본 노트 볼트 — 만들고 ce 루트로 등록
        if (self.ceRoots == nil) self.ceRoots = [NSMutableSet set];
        NSFileManager *fm = NSFileManager.defaultManager;
        NSString *base = OmniBaseDir();
        NSString *dir = nil;
        if ([cmd isEqualToString:@"notes.vault"]) {
            dir = [base stringByAppendingPathComponent:@"Notes"];
            [fm createDirectoryAtPath:dir withIntermediateDirectories:YES
                           attributes:nil error:nil];
        } else {
            NSDictionary *a = nil;
            if (arg != nil) {
                NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
                id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
                if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
            }
            NSString *name = [a[@"name"] isKindOfClass:[NSString class]] ? a[@"name"] : nil;
            name = [[name componentsSeparatedByCharactersInSet:
                [NSCharacterSet characterSetWithCharactersInString:@"/\\:*?\"<>|"]]
                componentsJoinedByString:@""];
            name = [name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
            if (name.length == 0) {
                [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
                return;
            }
            dir = [[base stringByAppendingPathComponent:@"Projects"]
                stringByAppendingPathComponent:name];
            for (NSString *sub in @[ @"3d", @"arduino", @"code", @"notes" ]) {
                [fm createDirectoryAtPath:[dir stringByAppendingPathComponent:sub]
              withIntermediateDirectories:YES attributes:nil error:nil];
            }
        }
        [self.ceRoots addObject:dir.stringByStandardizingPath];
        [self deliverPayload:@{ @"ok" : @YES, @"path" : dir } forId:msgId];
    } else if ([cmd hasPrefix:@"ce."]) {
        NSDictionary *a = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
        }
        if (self.ceRoots == nil) self.ceRoots = [NSMutableSet set];
        if (self.terms == nil) {
            __weak AppDelegate *weakSelf = self;
            self.terms = [[OmniTermManager alloc] initWithEmit:^(NSString *js) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    [weakSelf.webView evaluateJavaScript:js completionHandler:nil];
                });
            }];
        }
        NSString *argPath = [a[@"path"] isKindOfClass:[NSString class]] ? a[@"path"] : nil;

        if ([cmd isEqualToString:@"ce.pickFolder"]) {
            dispatch_async(dispatch_get_main_queue(), ^{
                NSOpenPanel *panel = [NSOpenPanel openPanel];
                panel.canChooseFiles = NO;
                panel.canChooseDirectories = YES;
                panel.allowsMultipleSelection = NO;
                panel.prompt = @"Open";
                [panel beginSheetModalForWindow:self.window
                              completionHandler:^(NSModalResponse result) {
                    if (result == NSModalResponseOK && panel.URL != nil) {
                        NSString *p = panel.URL.path.stringByStandardizingPath;
                        [self.ceRoots addObject:p];
                        [self deliverPayload:@{ @"ok" : @YES, @"path" : p } forId:msgId];
                    } else {
                        [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
                    }
                }];
            });
        } else if ([cmd isEqualToString:@"ce.addRoot"]) {
            // 최근 폴더 재오픈용 — 존재하는 디렉토리만
            BOOL isDir = NO;
            NSString *std = argPath.stringByStandardizingPath;
            BOOL ok = std != nil
                && [NSFileManager.defaultManager fileExistsAtPath:std isDirectory:&isDir]
                && isDir;
            if (ok) [self.ceRoots addObject:std];
            [self deliverPayload:@{ @"ok" : @(ok), @"path" : ok ? std : @"" } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.tree"]) {
            NSString *std = [self ceValidatePath:argPath];
            [self deliverPayload:(std ? CETree(std) : @{ @"ok" : @NO }) forId:msgId];
        } else if ([cmd isEqualToString:@"ce.read"]) {
            NSString *std = [self ceValidatePath:argPath];
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                [self deliverPayload:(std ? CERead(std) : @{ @"ok" : @NO }) forId:msgId];
            });
        } else if ([cmd isEqualToString:@"ce.writeBin"]) {
            NSString *std = [self ceValidatePath:argPath];
            NSString *b64 = [a[@"data"] isKindOfClass:[NSString class]] ? a[@"data"] : nil;
            NSData *data = b64 ? [[NSData alloc] initWithBase64EncodedString:b64 options:0] : nil;
            BOOL ok = std != nil && data != nil && [data writeToFile:std atomically:YES];
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.write"]) {
            NSString *std = [self ceValidatePath:argPath];
            NSString *text = [a[@"data"] isKindOfClass:[NSString class]] ? a[@"data"] : nil;
            BOOL ok = std != nil && text != nil && CEWrite(std, text);
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.rename"] || [cmd isEqualToString:@"ce.copy"]) {
            // 이동(rename)/복사 — 원본·대상 모두 루트 안이어야 함
            NSString *src = [self ceValidatePath:argPath];
            NSString *toReq = [a[@"to"] isKindOfClass:[NSString class]] ? a[@"to"] : nil;
            NSString *dst = [self ceValidatePath:toReq];
            NSFileManager *fm = NSFileManager.defaultManager;
            BOOL ok = NO;
            if (src != nil && dst != nil && ![fm fileExistsAtPath:dst]) {
                if ([cmd isEqualToString:@"ce.rename"]) {
                    ok = [fm moveItemAtPath:src toPath:dst error:nil];
                } else {
                    ok = [fm copyItemAtPath:src toPath:dst error:nil];
                }
            }
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.trash"]) {
            // 삭제는 휴지통 이동 — 복구 가능
            NSString *std = [self ceValidatePath:argPath];
            BOOL ok = NO;
            if (std != nil) {
                ok = [NSFileManager.defaultManager
                    trashItemAtURL:[NSURL fileURLWithPath:std]
                  resultingItemURL:nil error:nil];
            }
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.mkdir"]) {
            NSString *std = argPath.stringByStandardizingPath;
            // 새 폴더의 부모가 루트 안이면 허용
            NSString *parent = [self ceValidatePath:std.stringByDeletingLastPathComponent];
            BOOL ok = NO;
            if (parent != nil && ![NSFileManager.defaultManager fileExistsAtPath:std]) {
                ok = [NSFileManager.defaultManager createDirectoryAtPath:std
                    withIntermediateDirectories:NO attributes:nil error:nil];
            }
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.reveal"]) {
            NSString *std = [self ceValidatePath:argPath];
            BOOL ok = std != nil
                && [[NSWorkspace sharedWorkspace] selectFile:std
                                    inFileViewerRootedAtPath:@""];
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.clip"]) {
            NSString *text = [a[@"text"] isKindOfClass:[NSString class]] ? a[@"text"] : nil;
            BOOL ok = NO;
            if (text != nil) {
                NSPasteboard *pb = NSPasteboard.generalPasteboard;
                [pb clearContents];
                ok = [pb setString:text forType:NSPasteboardTypeString];
            }
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.termOpen"]) {
            NSString *cwd = [self ceValidatePath:argPath] ?: NSHomeDirectory();
            int cols = [a[@"cols"] intValue] ?: 80;
            int rows = [a[@"rows"] intValue] ?: 24;
            [self deliverPayload:[self.terms openWithCwd:cwd cols:cols rows:rows]
                           forId:msgId];
        } else if ([cmd isEqualToString:@"ce.termWrite"]) {
            NSString *b64 = [a[@"data"] isKindOfClass:[NSString class]] ? a[@"data"] : nil;
            NSData *data = b64 ? [[NSData alloc] initWithBase64EncodedString:b64 options:0] : nil;
            BOOL ok = data != nil && [self.terms writeTid:[a[@"tid"] integerValue] data:data];
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.termResize"]) {
            BOOL ok = [self.terms resizeTid:[a[@"tid"] integerValue]
                                       cols:[a[@"cols"] intValue]
                                       rows:[a[@"rows"] intValue]];
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        } else if ([cmd isEqualToString:@"ce.termClose"]) {
            [self.terms closeTid:[a[@"tid"] integerValue]];
            [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
        } else {
            [self deliverPayload:@{ @"ok" : @NO, @"err" : @"unknown ce command" } forId:msgId];
        }
    } else if ([cmd isEqualToString:@"open.app"]) {
        // 알림 클릭 → 원본 앱 열기 (허용 목록 한정)
        NSDictionary *oa = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) oa = parsed;
        }
        NSString *bundle = [oa[@"bundle"] isKindOfClass:[NSString class]] ? oa[@"bundle"] : @"";
        NSArray *allowed = @[ @"com.kakao.KakaoTalkMac", @"com.apple.mail" ];
        if (![allowed containsObject:bundle]) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"not allowed" } forId:msgId];
            return;
        }
        NSURL *appURL = [NSWorkspace.sharedWorkspace
            URLForApplicationWithBundleIdentifier:bundle];
        if (appURL == nil) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"app not found" } forId:msgId];
            return;
        }
        NSWorkspaceOpenConfiguration *conf = [NSWorkspaceOpenConfiguration configuration];
        [NSWorkspace.sharedWorkspace openApplicationAtURL:appURL
                                            configuration:conf
                                        completionHandler:nil];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"open.url"]) {
        // 기본 브라우저로 링크 열기 — http(s)만 허용
        NSString *urlStr = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]
                && [parsed[@"url"] isKindOfClass:[NSString class]]) {
                urlStr = parsed[@"url"];
            }
        }
        NSURL *url = urlStr ? [NSURL URLWithString:urlStr] : nil;
        BOOL ok = NO;
        if (url != nil && ([url.scheme isEqualToString:@"https"]
                           || [url.scheme isEqualToString:@"http"])) {
            ok = [[NSWorkspace sharedWorkspace] openURL:url];
        }
        [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
    } else if ([cmd isEqualToString:@"store.read"] || [cmd isEqualToString:@"store.write"]) {
        // 패널 데이터 영속화용 미니 스토어 — ~/.omni/store/<name>.json 한정
        NSDictionary *a = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
        }
        NSString *name = [a[@"name"] isKindOfClass:[NSString class]] ? a[@"name"] : nil;
        NSRegularExpression *re = [NSRegularExpression
            regularExpressionWithPattern:@"^[A-Za-z0-9_-]{1,64}$" options:0 error:nil];
        BOOL valid = name != nil && [re numberOfMatchesInString:name options:0
            range:NSMakeRange(0, name.length)] == 1;
        if (!valid) {
            [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
        } else {
            NSString *dir = [NSHomeDirectory()
                stringByAppendingPathComponent:@".omni/store"];
            [NSFileManager.defaultManager createDirectoryAtPath:dir
                withIntermediateDirectories:YES attributes:nil error:nil];
            NSString *path = [dir stringByAppendingPathComponent:
                [name stringByAppendingPathExtension:@"json"]];
            if ([cmd isEqualToString:@"store.read"]) {
                NSString *data = [NSString stringWithContentsOfFile:path
                    encoding:NSUTF8StringEncoding error:nil];
                [self deliverPayload:@{ @"ok" : @YES,
                                        @"data" : data ?: [NSNull null] } forId:msgId];
            } else {
                NSString *data = [a[@"data"] isKindOfClass:[NSString class]] ? a[@"data"] : nil;
                BOOL ok = data != nil
                    && [data writeToFile:path atomically:YES
                                encoding:NSUTF8StringEncoding error:nil];
                [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
            }
        }
    } else if ([cmd isEqualToString:@"git.recent"]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            NSString *root = OmniBaseDir().stringByDeletingLastPathComponent;
            NSFileManager *fm = NSFileManager.defaultManager;
            NSMutableArray *all = [NSMutableArray array];
            for (NSString *name in [fm contentsOfDirectoryAtPath:root error:nil]) {
                if ([name hasPrefix:@"."]) continue;
                NSString *repo = [root stringByAppendingPathComponent:name];
                BOOL isDir = NO;
                if (![fm fileExistsAtPath:repo isDirectory:&isDir] || !isDir) continue;
                if (![fm fileExistsAtPath:[repo stringByAppendingPathComponent:@".git"]]) continue;
                NSTask *t = [[NSTask alloc] init];
                t.executableURL = [NSURL fileURLWithPath:@"/usr/bin/git"];
                t.arguments = @[ @"-C", repo, @"log", @"-4",
                    @"--format=%ct%x1f%s", @"--no-merges" ];
                NSPipe *p = [NSPipe pipe];
                t.standardOutput = p;
                t.standardError = [NSPipe pipe];
                if (![t launchAndReturnError:nil]) continue;
                NSData *d = [p.fileHandleForReading readDataToEndOfFile];
                [t waitUntilExit];
                NSString *out = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] ?: @"";
                for (NSString *line in [out componentsSeparatedByString:@"\n"]) {
                    NSArray *parts = [line componentsSeparatedByString:@"\x1f"];
                    if (parts.count < 2) continue;
                    [all addObject:@{ @"repo" : name,
                                      @"ts" : @([parts[0] doubleValue]),
                                      @"msg" : parts[1] }];
                }
            }
            [all sortUsingComparator:^NSComparisonResult(NSDictionary *x, NSDictionary *y) {
                return [(NSNumber *)y[@"ts"] compare:(NSNumber *)x[@"ts"]];
            }];
            NSArray *top = all.count > 14 ? [all subarrayWithRange:NSMakeRange(0, 14)] : all;
            [self deliverPayload:@{ @"ok" : @YES, @"commits" : top } forId:msgId];
        });
    } else if ([cmd isEqualToString:@"sys.stats"]) {
        // 시스템 지표는 전용 직렬 큐에서 — 델타 static이 경쟁하지 않게
        static dispatch_queue_t sysQ;
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            sysQ = dispatch_queue_create("omni.sysmon", DISPATCH_QUEUE_SERIAL);
        });
        dispatch_async(sysQ, ^{
            [self deliverPayload:SysmonCollect() forId:msgId];
        });
    } else if ([cmd isEqualToString:@"sp1.status"]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self deliverPayload:SP1CollectStatus() forId:msgId];
        });
    } else if ([cmd isEqualToString:@"sp1.intruders"]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self deliverPayload:@{ @"items" : SP1CollectIntruders() } forId:msgId];
        });
    } else if ([cmd isEqualToString:@"sp1.intruderImage"]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self deliverPayload:(SP1IntruderImage(arg) ?: @{}) forId:msgId];
        });
    } else if ([cmd isEqualToString:@"sp1.pause"]) {
        // cleanly stop the SP-1 watcher: hand gestures must not trigger a
        // lockdown, and its capture session must fully release the shared
        // camera (a frozen process stalls the whole camera pipeline)
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            BOOL ok = SP1PauseWatcher();
            [self deliverPayload:@{ @"paused" : @(ok) } forId:msgId];
        });
    } else if ([cmd isEqualToString:@"sp1.resume"]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            SP1ResumeWatcher();
            [self deliverPayload:@{ @"resumed" : @YES } forId:msgId];
        });
    } else if ([cmd isEqualToString:@"arc.connect"]) {
        // ARC-SCAN: native WebSocket to the ESP32 (plain ws:// would be
        // blocked as mixed content from the app's secure custom scheme)
        NSURL *u = arg ? [NSURL URLWithString:arg] : nil;
        if (u == nil || !([u.scheme isEqualToString:@"ws"] || [u.scheme isEqualToString:@"wss"])) {
            [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
        } else {
            [self.arcTask cancel];
            self.arcTask = [[NSURLSession sharedSession] webSocketTaskWithURL:u];
            [self.arcTask resume];
            [self arcReceiveLoop:self.arcTask];
            // handshake probe: a pong means the socket is actually open — the
            // ESP32 stays silent until it gets a "start" command, so we can't
            // rely on the first data message to signal the link
            NSURLSessionWebSocketTask *probe = self.arcTask;
            [probe sendPingWithPongReceiveHandler:^(NSError *e) {
                if (probe != self.arcTask) return;
                [self arcEvalJS:(e == nil
                    ? @"window.OmniArc && window.OmniArc._state(\"open\")"
                    : @"window.OmniArc && window.OmniArc._state(\"closed\")")];
            }];
            [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
        }
    } else if ([cmd isEqualToString:@"arc.send"]) {
        // scan control commands ("start"/"stop"/"center") to the ESP32
        if (self.arcTask != nil && arg != nil) {
            NSURLSessionWebSocketMessage *m =
                [[NSURLSessionWebSocketMessage alloc] initWithString:arg];
            [self.arcTask sendMessage:m completionHandler:^(NSError *e) {}];
            [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
        } else {
            [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
        }
    } else if ([cmd isEqualToString:@"arc.savePly"]) {
        // auto-save the export into ARC-SCAN-SAVES (no panel)
        NSDictionary *a = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
        }
        NSString *b64 = [a[@"data"] isKindOfClass:[NSString class]] ? a[@"data"] : nil;
        NSString *fname = [a[@"name"] isKindOfClass:[NSString class]] ? a[@"name"] : @"arc_scan.ply";
        fname = fname.lastPathComponent; // never allow path escapes
        if (![fname.pathExtension.lowercaseString isEqualToString:@"ply"]) {
            fname = [fname stringByAppendingPathExtension:@"ply"] ?: @"arc_scan.ply";
        }
        NSData *data = b64 ? [[NSData alloc] initWithBase64EncodedString:b64 options:0] : nil;
        if (data == nil) {
            [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
        } else {
            NSString *path = [ArcSavesDir() stringByAppendingPathComponent:fname];
            BOOL ok = [data writeToFile:path atomically:YES];
            [self deliverPayload:@{ @"ok" : @(ok), @"path" : path ?: @"", @"name" : fname }
                           forId:msgId];
        }
    } else if ([cmd isEqualToString:@"arc.listSaves"]) {
        // newest-first listing of ARC-SCAN-SAVES/*.ply
        NSString *dir = ArcSavesDir();
        NSFileManager *fm = NSFileManager.defaultManager;
        NSMutableArray *files = [NSMutableArray array];
        for (NSString *f in [fm contentsOfDirectoryAtPath:dir error:nil]) {
            if (![f.pathExtension.lowercaseString isEqualToString:@"ply"]) continue;
            NSString *p = [dir stringByAppendingPathComponent:f];
            NSDictionary *at = [fm attributesOfItemAtPath:p error:nil];
            NSTimeInterval mt = at.fileModificationDate.timeIntervalSince1970;
            [files addObject:@{ @"name" : f, @"path" : p, @"mtime" : @(mt) }];
        }
        [files sortUsingComparator:^NSComparisonResult(NSDictionary *x, NSDictionary *y) {
            return [(NSNumber *)y[@"mtime"] compare:(NSNumber *)x[@"mtime"]];
        }];
        [self deliverPayload:@{ @"ok" : @YES, @"files" : files } forId:msgId];
    } else if ([cmd isEqualToString:@"arc.readPly"]) {
        // read a saved scan back — restricted to the ARC-SCAN-SAVES folder
        NSDictionary *a = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
        }
        NSString *reqPath = [a[@"path"] isKindOfClass:[NSString class]] ? a[@"path"] : nil;
        NSString *dir = ArcSavesDir();
        NSString *std = reqPath.stringByStandardizingPath;
        BOOL inside = std != nil && [std hasPrefix:[dir stringByAppendingString:@"/"]];
        NSData *data = inside ? [NSData dataWithContentsOfFile:std] : nil;
        if (data == nil) {
            [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
        } else {
            [self deliverPayload:@{ @"ok" : @YES,
                                    @"name" : std.lastPathComponent,
                                    @"data" : [data base64EncodedStringWithOptions:0] }
                           forId:msgId];
        }
    } else if ([cmd isEqualToString:@"arc.disconnect"]) {
        [self.arcTask cancel];
        self.arcTask = nil;
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
    } else if ([cmd hasPrefix:@"ai."]) {
        [self handleAI:cmd arg:arg msgId:msgId];
    } else if ([cmd hasPrefix:@"arduino."]) {
        [self handleArduino:cmd arg:arg msgId:msgId];
    } else if ([cmd isEqualToString:@"sp1.start"]) {
        // panel START button when the watcher is found offline
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self deliverPayload:@{ @"started" : @(SP1StartWatcher()) } forId:msgId];
        });
    }
    // unknown commands are ignored; the JS side times out on its own
}

// ---- OMNI_AI: 음성 인식 / Claude 대화 / 로봇 TTS ----

static NSString *OmniAIKeyPath(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@".omni/anthropic.key"];
}

static NSString *OmniAIReadKey(void) {
    NSString *raw = [NSString stringWithContentsOfFile:OmniAIKeyPath()
                                              encoding:NSUTF8StringEncoding
                                                 error:nil];
    NSString *key = [raw stringByTrimmingCharactersInSet:
        NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return key.length > 10 ? key : nil;
}

static NSString *OmniAIOpenAIKeyPath(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@".omni/openai.key"];
}

static NSString *OmniAIOpenAIKey(void) {
    NSString *raw = [NSString stringWithContentsOfFile:OmniAIOpenAIKeyPath()
                                              encoding:NSUTF8StringEncoding
                                                 error:nil];
    NSString *key = [raw stringByTrimmingCharactersInSet:
        NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return key.length > 10 ? key : nil;
}

// evaluateJavaScript 인라인용 JSON 문자열 (U+2028/2029 이스케이프)
static NSString *OmniAIJSON(NSDictionary *obj) {
    NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    if (d == nil) return nil;
    NSMutableString *s = [[[NSString alloc] initWithData:d
                                                encoding:NSUTF8StringEncoding] mutableCopy];
    [s replaceOccurrencesOfString:[NSString stringWithFormat:@"%C", (unichar)0x2028]
                       withString:@"\\u2028" options:0 range:NSMakeRange(0, s.length)];
    [s replaceOccurrencesOfString:[NSString stringWithFormat:@"%C", (unichar)0x2029]
                       withString:@"\\u2029" options:0 range:NSMakeRange(0, s.length)];
    return s;
}

// 신경망 로봇 보이스 사용 가능 여부 (엔진 + 학습된 음색 프로파일)
static NSString *OmniAIProfilePath(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@".omni/omni_ai_voice.pt"];
}

static BOOL OmniAINeuralAvailable(void) {
    NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
    NSFileManager *fm = NSFileManager.defaultManager;
    return [fm isExecutableFileAtPath:[eng stringByAppendingPathComponent:@"venv/bin/python"]]
        && [fm fileExistsAtPath:[eng stringByAppendingPathComponent:@"worker.py"]]
        && [fm fileExistsAtPath:OmniAIProfilePath()];
}

// TTS 변환 데몬 기동 보장 — done(ready)는 메인 큐에서 호출
- (void)aiTtsEnsure:(void (^)(BOOL))done {
    if (self.aiTtsTask != nil && self.aiTtsTask.isRunning) {
        if (self.aiTtsReady) { done(YES); return; }
        [self.aiTtsWaiters addObject:[done copy]];
        return;
    }
    if (!OmniAINeuralAvailable()) { done(NO); return; }
    self.aiTtsReady = NO;
    self.aiTtsBuf = [NSMutableString string];
    if (self.aiTtsWaiters == nil) self.aiTtsWaiters = [NSMutableArray array];
    [self.aiTtsWaiters addObject:[done copy]];

    NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:
        [eng stringByAppendingPathComponent:@"venv/bin/python"]];
    task.arguments = @[ [eng stringByAppendingPathComponent:@"worker.py"],
                        @"ttsserve", OmniAIProfilePath(),
                        [NSHomeDirectory() stringByAppendingPathComponent:
                            @".omni/omni_ai_voice_ref.wav"] ];
    NSPipe *inPipe = [NSPipe pipe];
    NSPipe *outPipe = [NSPipe pipe];
    NSPipe *errPipe = [NSPipe pipe];
    task.standardInput = inPipe;
    task.standardOutput = outPipe;
    task.standardError = errPipe;
    // stderr(모델 로그)는 버퍼가 차서 데몬이 막히지 않게 계속 비운다
    errPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *fh) {
        (void)fh.availableData;
    };
    __weak AppDelegate *weakSelf = self;
    outPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *fh) {
        NSData *d = fh.availableData;
        if (d.length == 0) return;
        NSString *s = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
        if (s == nil) return;
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf aiTtsConsume:s];
        });
    };
    task.terminationHandler = ^(NSTask *t) {
        outPipe.fileHandleForReading.readabilityHandler = nil;
        errPipe.fileHandleForReading.readabilityHandler = nil;
        dispatch_async(dispatch_get_main_queue(), ^{
            AppDelegate *s = weakSelf;
            if (s == nil) return;
            s.aiTtsReady = NO;
            s.aiTtsTask = nil;
            s.aiTtsIn = nil;
            for (void (^w)(BOOL) in s.aiTtsWaiters) w(NO);
            [s.aiTtsWaiters removeAllObjects];
            [s aiTtsFailPending:@"daemon exited"];
        });
    };
    NSError *err = nil;
    if (![task launchAndReturnError:&err]) {
        for (void (^w)(BOOL) in self.aiTtsWaiters) w(NO);
        [self.aiTtsWaiters removeAllObjects];
        return;
    }
    self.aiTtsTask = task;
    self.aiTtsIn = inPipe;
}

// 데몬 stdout 라인 처리 (메인 큐)
- (void)aiTtsConsume:(NSString *)chunk {
    [self.aiTtsBuf appendString:chunk];
    NSRange nl;
    while ((nl = [self.aiTtsBuf rangeOfString:@"\n"]).location != NSNotFound) {
        NSString *line = [[self.aiTtsBuf substringToIndex:nl.location]
            stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        [self.aiTtsBuf deleteCharactersInRange:NSMakeRange(0, nl.location + 1)];
        if (line.length == 0) continue;
        if ([line isEqualToString:@"READY"]) {
            self.aiTtsReady = YES;
            for (void (^w)(BOOL) in self.aiTtsWaiters) w(YES);
            [self.aiTtsWaiters removeAllObjects];
            continue;
        }
        // 변환 응답 JSON
        NSNumber *msgId = self.aiTtsPendingId;
        if (msgId == nil) continue; // 타임아웃 뒤 늦게 온 응답
        NSString *inPath = self.aiTtsPendingIn, *outPath = self.aiTtsPendingOut;
        self.aiTtsPendingId = nil;
        self.aiTtsPendingIn = nil;
        self.aiTtsPendingOut = nil;
        NSData *jd = [line dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *r = jd ? [NSJSONSerialization JSONObjectWithData:jd
                                                               options:0 error:nil] : nil;
        BOOL ok = [r isKindOfClass:[NSDictionary class]] && [r[@"ok"] boolValue];
        NSData *wav = ok ? [NSData dataWithContentsOfFile:outPath] : nil;
        [NSFileManager.defaultManager removeItemAtPath:inPath error:nil];
        [NSFileManager.defaultManager removeItemAtPath:outPath error:nil];
        if (wav.length == 0) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NEURAL_FAIL" } forId:msgId];
        } else {
            [self deliverPayload:@{ @"ok" : @YES, @"neural" : @YES,
                                    @"wav" : [wav base64EncodedStringWithOptions:0] }
                           forId:msgId];
        }
    }
}

- (void)aiTtsFailPending:(NSString *)reason {
    if (self.aiTtsPendingId == nil) return;
    NSNumber *msgId = self.aiTtsPendingId;
    if (self.aiTtsPendingIn != nil) {
        [NSFileManager.defaultManager removeItemAtPath:self.aiTtsPendingIn error:nil];
    }
    self.aiTtsPendingId = nil;
    self.aiTtsPendingIn = nil;
    self.aiTtsPendingOut = nil;
    [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NEURAL_FAIL" } forId:msgId];
}

// ---- 외국어 음색 데몬 (Seed-VC) — kNN과 달리 발음을 소스 그대로 보존 ----

static NSString *OmniAISeedRefPath(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@".omni/omni_ai_seed_ref.wav"];
}

static BOOL OmniAISeedAvailable(void) {
    NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
    NSFileManager *fm = NSFileManager.defaultManager;
    return [fm isExecutableFileAtPath:
               [eng stringByAppendingPathComponent:@"seedvc/venv/bin/python"]]
        && [fm fileExistsAtPath:[eng stringByAppendingPathComponent:@"seed_serve.py"]]
        && [fm fileExistsAtPath:OmniAISeedRefPath()];
}

- (void)aiSeedEnsure:(void (^)(BOOL))done {
    if (self.aiSeedTask != nil && self.aiSeedTask.isRunning) {
        if (self.aiSeedReady) { done(YES); return; }
        [self.aiSeedWaiters addObject:[done copy]];
        return;
    }
    if (!OmniAISeedAvailable()) { done(NO); return; }
    self.aiSeedReady = NO;
    self.aiSeedBuf = [NSMutableString string];
    if (self.aiSeedWaiters == nil) self.aiSeedWaiters = [NSMutableArray array];
    [self.aiSeedWaiters addObject:[done copy]];

    NSString *eng = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine"];
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:
        [eng stringByAppendingPathComponent:@"seedvc/venv/bin/python"]];
    task.arguments = @[ [eng stringByAppendingPathComponent:@"seed_serve.py"],
                        OmniAISeedRefPath(), @"15" ];
    NSPipe *inPipe = [NSPipe pipe];
    NSPipe *outPipe = [NSPipe pipe];
    NSPipe *errPipe = [NSPipe pipe];
    task.standardInput = inPipe;
    task.standardOutput = outPipe;
    task.standardError = errPipe;
    errPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *fh) {
        (void)fh.availableData; // 모델 로그로 버퍼가 차지 않게 비움
    };
    __weak AppDelegate *weakSelf = self;
    outPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *fh) {
        NSData *d = fh.availableData;
        if (d.length == 0) return;
        NSString *s = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
        if (s == nil) return;
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf aiSeedConsume:s];
        });
    };
    task.terminationHandler = ^(NSTask *t) {
        outPipe.fileHandleForReading.readabilityHandler = nil;
        errPipe.fileHandleForReading.readabilityHandler = nil;
        dispatch_async(dispatch_get_main_queue(), ^{
            AppDelegate *s = weakSelf;
            if (s == nil) return;
            s.aiSeedReady = NO;
            s.aiSeedTask = nil;
            s.aiSeedIn = nil;
            for (void (^w)(BOOL) in s.aiSeedWaiters) w(NO);
            [s.aiSeedWaiters removeAllObjects];
            [s aiSeedFailPending];
        });
    };
    NSError *err = nil;
    if (![task launchAndReturnError:&err]) {
        for (void (^w)(BOOL) in self.aiSeedWaiters) w(NO);
        [self.aiSeedWaiters removeAllObjects];
        return;
    }
    self.aiSeedTask = task;
    self.aiSeedIn = inPipe;
}

- (void)aiSeedConsume:(NSString *)chunk {
    [self.aiSeedBuf appendString:chunk];
    NSRange nl;
    while ((nl = [self.aiSeedBuf rangeOfString:@"\n"]).location != NSNotFound) {
        NSString *line = [[self.aiSeedBuf substringToIndex:nl.location]
            stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        [self.aiSeedBuf deleteCharactersInRange:NSMakeRange(0, nl.location + 1)];
        if (line.length == 0) continue;
        if ([line isEqualToString:@"READY"]) {
            self.aiSeedReady = YES;
            for (void (^w)(BOOL) in self.aiSeedWaiters) w(YES);
            [self.aiSeedWaiters removeAllObjects];
            continue;
        }
        NSNumber *msgId = self.aiSeedPendingId;
        if (msgId == nil) continue;
        NSString *inPath = self.aiSeedPendingIn, *outPath = self.aiSeedPendingOut;
        self.aiSeedPendingId = nil;
        self.aiSeedPendingIn = nil;
        self.aiSeedPendingOut = nil;
        NSData *jd = [line dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *r = jd ? [NSJSONSerialization JSONObjectWithData:jd
                                                               options:0 error:nil] : nil;
        BOOL ok = [r isKindOfClass:[NSDictionary class]] && [r[@"ok"] boolValue];
        NSData *wav = ok ? [NSData dataWithContentsOfFile:outPath] : nil;
        [NSFileManager.defaultManager removeItemAtPath:inPath error:nil];
        [NSFileManager.defaultManager removeItemAtPath:outPath error:nil];
        if (wav.length == 0) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NEURAL_FAIL" } forId:msgId];
        } else {
            [self deliverPayload:@{ @"ok" : @YES, @"neural" : @YES,
                                    @"wav" : [wav base64EncodedStringWithOptions:0] }
                           forId:msgId];
        }
    }
}

- (void)aiSeedFailPending {
    if (self.aiSeedPendingId == nil) return;
    NSNumber *msgId = self.aiSeedPendingId;
    if (self.aiSeedPendingIn != nil) {
        [NSFileManager.defaultManager removeItemAtPath:self.aiSeedPendingIn error:nil];
    }
    self.aiSeedPendingId = nil;
    self.aiSeedPendingIn = nil;
    self.aiSeedPendingOut = nil;
    [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NEURAL_FAIL" } forId:msgId];
}

// say 실행 → wav 파일 (완료 블록은 배경 큐에서 호출)
- (BOOL)aiRunSay:(NSString *)text voice:(NSString *)voice rate:(NSNumber *)rate
          toFile:(NSString *)path {
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/say"];
    NSMutableArray *args = [@[ @"-v", voice ] mutableCopy];
    if (rate.intValue > 0) { // 0 = 보이스 기본 속도
        [args addObjectsFromArray:@[ @"-r", rate.stringValue ]];
    }
    [args addObjectsFromArray:@[ @"-o", path, @"--data-format=LEI16@22050" ]];
    task.arguments = args;
    NSPipe *inPipe = [NSPipe pipe];
    task.standardInput = inPipe;
    task.standardError = [NSPipe pipe];
    NSError *err = nil;
    if (![task launchAndReturnError:&err]) return NO;
    [inPipe.fileHandleForWriting writeData:[text dataUsingEncoding:NSUTF8StringEncoding]];
    [inPipe.fileHandleForWriting closeFile];
    [task waitUntilExit];
    unsigned long long size = [[NSFileManager.defaultManager
        attributesOfItemAtPath:path error:nil] fileSize];
    return task.terminationStatus == 0 && size > 100;
}

// ---- OMNI_AI 리얼타임 수신 루프 — arc 릴레이와 같은 패턴 ----
- (void)aiRtReceiveLoop:(NSURLSessionWebSocketTask *)task {
    __weak AppDelegate *weakSelf = self;
    [task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *msg,
                                                NSError *error) {
        AppDelegate *s = weakSelf;
        if (s == nil || task != s.aiRtTask) return; // 새 세션으로 대체됨
        if (error != nil) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [s.webView evaluateJavaScript:
                    @"window.OmniAI && OmniAI._rt({type:\"rt.closed\"})"
                          completionHandler:nil];
            });
            return;
        }
        if (msg.type == NSURLSessionWebSocketMessageTypeString && msg.string != nil) {
            // JSON 재직렬화로 스크립트 주입 차단 (arc 릴레이와 동일)
            NSData *raw = [msg.string dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = raw ? [NSJSONSerialization JSONObjectWithData:raw
                                                              options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) {
                NSData *safe = [NSJSONSerialization dataWithJSONObject:parsed
                                                               options:0 error:nil];
                NSString *json = [[NSString alloc] initWithData:safe
                                                       encoding:NSUTF8StringEncoding];
                if (json != nil) {
                    NSString *js = [NSString stringWithFormat:
                        @"window.OmniAI && OmniAI._rt(%@)", json];
                    dispatch_async(dispatch_get_main_queue(), ^{
                        [s.webView evaluateJavaScript:js completionHandler:nil];
                    });
                }
            }
        }
        [s aiRtReceiveLoop:task];
    }];
}

// ---- OMNI_AI 알림 센터 리더 — 카톡 등 앱 알림 확인 (전체 디스크 접근 필요) ----
// 카톡은 개인 메시지 공식 API가 없어, 맥 알림 센터 DB(usernoted)의
// 보낸사람+미리보기를 읽는 방식이 유일하게 견고하다. 읽기 전용.

- (void)handleAINotif:(NSDictionary *)a msgId:(NSNumber *)msgId {
    NSString *bundle = [a[@"bundle"] isKindOfClass:[NSString class]] ? a[@"bundle"] : nil;
    double hours = [a[@"hours"] isKindOfClass:[NSNumber class]]
        ? [a[@"hours"] doubleValue] : 24.0;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSString *dbPath = [NSHomeDirectory() stringByAppendingPathComponent:
            @"Library/Group Containers/group.com.apple.usernoted/db2/db"];
        // 진단: 파일 접근 자체가 막히면 TCC(전체 디스크 접근) 문제,
        // 열리는데 sqlite가 실패하면 다른 원인 — 구분해서 보고
        errno = 0;
        if (access(dbPath.UTF8String, R_OK) != 0) {
            int e = errno;
            [self deliverPayload:@{ @"ok" : @NO,
                @"error" : (e == EPERM || e == EACCES) ? @"FDA_REQUIRED"
                    : [NSString stringWithFormat:@"DB_ACCESS: %s", strerror(e)] }
                           forId:msgId];
            return;
        }
        sqlite3 *db = NULL;
        if (sqlite3_open_v2(dbPath.UTF8String, &db, SQLITE_OPEN_READONLY, NULL)
            != SQLITE_OK) {
            NSString *msg = db != NULL
                ? [NSString stringWithFormat:@"SQLITE: %s", sqlite3_errmsg(db)]
                : @"SQLITE: open failed";
            if (db != NULL) sqlite3_close(db);
            [self deliverPayload:@{ @"ok" : @NO, @"error" : msg } forId:msgId];
            return;
        }
        // Core Data 타임스탬프(2001-01-01 기준 초) 컷오프
        double cutoff = [NSDate.date timeIntervalSinceReferenceDate] - hours * 3600.0;
        const char *sql =
            "SELECT app.identifier, record.delivered_date, record.data "
            "FROM record JOIN app ON record.app_id = app.app_id "
            "WHERE record.delivered_date > ? ORDER BY record.delivered_date DESC LIMIT 200";
        sqlite3_stmt *stmt = NULL;
        NSMutableArray *out = [NSMutableArray array];
        if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
            sqlite3_bind_double(stmt, 1, cutoff);
            while (sqlite3_step(stmt) == SQLITE_ROW && out.count < 100) {
                const char *ident = (const char *)sqlite3_column_text(stmt, 0);
                NSString *app = ident ? [NSString stringWithUTF8String:ident] : @"";
                if (bundle.length > 0
                    && ![app.lowercaseString containsString:bundle.lowercaseString]) {
                    continue;
                }
                double ts = sqlite3_column_double(stmt, 1);
                const void *blob = sqlite3_column_blob(stmt, 2);
                int blobLen = sqlite3_column_bytes(stmt, 2);
                NSString *title = @"", *subtitle = @"", *body = @"";
                if (blob != NULL && blobLen > 0) {
                    NSData *data = [NSData dataWithBytes:blob length:blobLen];
                    NSDictionary *plist = [NSPropertyListSerialization
                        propertyListWithData:data options:NSPropertyListImmutable
                                      format:NULL error:NULL];
                    NSDictionary *req = [plist[@"req"] isKindOfClass:[NSDictionary class]]
                        ? plist[@"req"] : @{};
                    title = [req[@"titl"] isKindOfClass:[NSString class]] ? req[@"titl"] : @"";
                    subtitle = [req[@"subt"] isKindOfClass:[NSString class]] ? req[@"subt"] : @"";
                    body = [req[@"body"] isKindOfClass:[NSString class]] ? req[@"body"] : @"";
                }
                if (title.length == 0 && body.length == 0) continue;
                [out addObject:@{ @"app" : app,
                                  @"ts" : @(ts + NSTimeIntervalSince1970),
                                  @"title" : title, @"subtitle" : subtitle,
                                  @"body" : body }];
            }
            sqlite3_finalize(stmt);
        }
        sqlite3_close(db);
        [self deliverPayload:@{ @"ok" : @YES, @"items" : out } forId:msgId];
    });
}

// ---- OMNI_AI 파일 도구 — 에이전트 루프가 쓰는 파일 시스템 접근 ----
// 사용자 승인 범위: ~/Desktop 아래 전체 (프로젝트·노트·작업 폴더 포함)

static NSString *OmniAIFsValidate(NSString *path) {
    NSString *std = path.stringByStandardizingPath;
    if (std == nil) return nil;
    NSString *root = [NSHomeDirectory() stringByAppendingPathComponent:@"Desktop"];
    if ([std isEqualToString:root] || [std hasPrefix:[root stringByAppendingString:@"/"]]) {
        return std;
    }
    return nil;
}

- (void)handleAIFs:(NSString *)cmd a:(NSDictionary *)a msgId:(NSNumber *)msgId {
    NSString *reqPath = [a[@"path"] isKindOfClass:[NSString class]] ? a[@"path"] : nil;
    NSString *path = reqPath ? OmniAIFsValidate(reqPath) : nil;
    if (path == nil) {
        [self deliverPayload:@{ @"ok" : @NO,
            @"error" : @"path outside allowed root (~/Desktop)" } forId:msgId];
        return;
    }
    NSFileManager *fm = NSFileManager.defaultManager;

    if ([cmd isEqualToString:@"ai.fsList"]) {
        BOOL recursive = [a[@"recursive"] boolValue];
        NSMutableArray *out = [NSMutableArray array];
        NSMutableArray *queue = [NSMutableArray arrayWithObject:path];
        NSSet *skip = [NSSet setWithArray:@[ @"node_modules", @".git", @"venv",
            @"dist", @"__pycache__", @".cache", @"seedvc" ]];
        while (queue.count > 0 && out.count < 800) {
            NSString *dir = queue.firstObject;
            [queue removeObjectAtIndex:0];
            for (NSString *name in [fm contentsOfDirectoryAtPath:dir error:nil]) {
                if ([name hasPrefix:@"."]) continue;
                NSString *full = [dir stringByAppendingPathComponent:name];
                BOOL isDir = NO;
                [fm fileExistsAtPath:full isDirectory:&isDir];
                unsigned long long size = isDir ? 0
                    : [[fm attributesOfItemAtPath:full error:nil] fileSize];
                [out addObject:@{ @"path" : full, @"dir" : @(isDir), @"size" : @(size) }];
                if (isDir && recursive && ![skip containsObject:name]) {
                    [queue addObject:full];
                }
                if (out.count >= 800) break;
            }
        }
        [self deliverPayload:@{ @"ok" : @YES, @"entries" : out,
                                @"truncated" : @(out.count >= 800) } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.fsRead"]) {
        NSString *text = [NSString stringWithContentsOfFile:path
                                                   encoding:NSUTF8StringEncoding error:nil];
        if (text == nil) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"unreadable (binary or missing)" }
                           forId:msgId];
            return;
        }
        NSArray *lines = [text componentsSeparatedByString:@"\n"];
        NSInteger offset = [a[@"offset"] isKindOfClass:[NSNumber class]]
            ? [a[@"offset"] integerValue] : 0;
        NSInteger limit = [a[@"limit"] isKindOfClass:[NSNumber class]]
            ? [a[@"limit"] integerValue] : 400;
        offset = MAX(0, MIN(offset, (NSInteger)lines.count));
        limit = MAX(1, MIN(limit, 1200));
        NSRange r = NSMakeRange(offset, MIN(limit, (NSInteger)lines.count - offset));
        NSString *slice = [[lines subarrayWithRange:r] componentsJoinedByString:@"\n"];
        if (slice.length > 80000) slice = [slice substringToIndex:80000];
        [self deliverPayload:@{ @"ok" : @YES, @"text" : slice,
                                @"totalLines" : @(lines.count),
                                @"offset" : @(offset) } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.fsWrite"]) {
        NSString *content = [a[@"content"] isKindOfClass:[NSString class]] ? a[@"content"] : nil;
        if (content == nil) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"no content" } forId:msgId];
            return;
        }
        [fm createDirectoryAtPath:path.stringByDeletingLastPathComponent
      withIntermediateDirectories:YES attributes:nil error:nil];
        NSError *err = nil;
        BOOL ok = [content writeToFile:path atomically:YES
                              encoding:NSUTF8StringEncoding error:&err];
        [self deliverPayload:@{ @"ok" : @(ok),
            @"error" : err.localizedDescription ?: @"" } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.fsEdit"]) {
        NSString *oldT = [a[@"old"] isKindOfClass:[NSString class]] ? a[@"old"] : nil;
        NSString *newT = [a[@"new"] isKindOfClass:[NSString class]] ? a[@"new"] : @"";
        NSString *text = [NSString stringWithContentsOfFile:path
                                                   encoding:NSUTF8StringEncoding error:nil];
        if (text == nil || oldT.length == 0) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"file unreadable or empty old" }
                           forId:msgId];
            return;
        }
        // 정확 일치 1회 치환 — 0회/다회면 실패 (엉뚱한 곳 수정 방지)
        NSUInteger count = 0, pos = 0;
        while (YES) {
            NSRange found = [text rangeOfString:oldT options:0
                                          range:NSMakeRange(pos, text.length - pos)];
            if (found.location == NSNotFound) break;
            count++;
            pos = found.location + found.length;
            if (count > 1) break;
        }
        if (count != 1) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : count == 0
                ? @"old text not found" : @"old text matches multiple places" } forId:msgId];
            return;
        }
        NSString *updated = [text stringByReplacingOccurrencesOfString:oldT
                                                            withString:newT
                                                               options:0
                                                                 range:NSMakeRange(0, text.length)];
        NSError *err = nil;
        BOOL ok = [updated writeToFile:path atomically:YES
                              encoding:NSUTF8StringEncoding error:&err];
        [self deliverPayload:@{ @"ok" : @(ok),
            @"error" : err.localizedDescription ?: @"" } forId:msgId];
    }
}

- (void)handleAI:(NSString *)cmd arg:(NSString *)arg msgId:(NSNumber *)msgId {
    NSDictionary *a = nil;
    if (arg != nil) {
        NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
        if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
    }

    if ([cmd isEqualToString:@"ai.status"]) {
        NSString *gmailKey = [NSHomeDirectory()
            stringByAppendingPathComponent:@".omni/gmail.key"];
        [self deliverPayload:@{ @"ok" : @YES,
                                @"key" : @(OmniAIReadKey() != nil),
                                @"openai" : @(OmniAIOpenAIKey() != nil),
                                @"gmail" : @([NSFileManager.defaultManager
                                    fileExistsAtPath:gmailKey]),
                                @"neural" : @(OmniAINeuralAvailable()),
                                @"listening" : @(self.aiListener.running) }
                       forId:msgId];

    } else if ([cmd isEqualToString:@"ai.warm"]) {
        // 클린 보이스 모드: 변조 데몬을 쓰지 않으므로 예열 없음 (상태만 보고).
        // 변조 데몬 코드는 유지 — 로봇 보이스로 되돌릴 때 재활성화
        [self deliverPayload:@{ @"ok" : @YES,
                                @"neural" : @(OmniAINeuralAvailable()),
                                @"seed" : @(OmniAISeedAvailable()) } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.saveKey"]) {
        NSString *key = [a[@"key"] isKindOfClass:[NSString class]] ? a[@"key"] : nil;
        key = [key stringByTrimmingCharactersInSet:
            NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (key.length < 10) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"invalid key" } forId:msgId];
            return;
        }
        NSString *provider = [a[@"provider"] isKindOfClass:[NSString class]]
            ? a[@"provider"] : @"";
        NSString *keyPath = [provider isEqualToString:@"openai"] ? OmniAIOpenAIKeyPath()
            : [provider isEqualToString:@"gmail"]
                ? [NSHomeDirectory() stringByAppendingPathComponent:@".omni/gmail.key"]
                : OmniAIKeyPath();
        NSString *dir = [NSHomeDirectory() stringByAppendingPathComponent:@".omni"];
        [NSFileManager.defaultManager createDirectoryAtPath:dir
                                withIntermediateDirectories:YES attributes:nil error:nil];
        NSError *err = nil;
        BOOL ok = [key writeToFile:keyPath atomically:YES
                          encoding:NSUTF8StringEncoding error:&err];
        if (ok) {
            [NSFileManager.defaultManager setAttributes:@{ NSFilePosixPermissions : @0600 }
                                           ofItemAtPath:keyPath error:nil];
        }
        [self deliverPayload:@{ @"ok" : @(ok),
                                @"error" : err.localizedDescription ?: @"" } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.listen"]) {
        if (self.aiListener == nil) {
            self.aiListener = [[OmniAIListener alloc] init];
            __weak AppDelegate *weakSelf = self;
            self.aiListener.onEvent = ^(NSDictionary *event) {
                NSString *json = OmniAIJSON(event);
                if (json == nil) return;
                NSString *js = [NSString stringWithFormat:
                    @"window.OmniAI && OmniAI._stt(%@)", json];
                [weakSelf.webView evaluateJavaScript:js completionHandler:nil];
            };
        }
        NSString *locale = [a[@"locale"] isKindOfClass:[NSString class]] ? a[@"locale"] : @"ko-KR";
        self.aiListener.localeId = locale;
        __weak AppDelegate *weakSelf = self;
        [self.aiListener requestAuthThen:^(BOOL granted, NSString *reason) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (granted) [weakSelf.aiListener start];
                [weakSelf deliverPayload:@{ @"ok" : @(granted), @"error" : reason ?: @"" }
                                   forId:msgId];
            });
        }];

    } else if ([cmd isEqualToString:@"ai.listenStop"]) {
        [self.aiListener stop];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.listenCancel"]) {
        [self.aiListener cancel];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.rtStart"]) {
        // gpt-realtime WSS 세션 시작 — 이벤트는 OmniAI._rt(...) 로 푸시
        NSString *oai = OmniAIOpenAIKey();
        if (oai == nil) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NO_OPENAI_KEY" } forId:msgId];
            return;
        }
        [self.aiRtTask cancel];
        NSString *model = [a[@"model"] isKindOfClass:[NSString class]]
            ? a[@"model"] : @"gpt-realtime";
        NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:
            [NSString stringWithFormat:@"wss://api.openai.com/v1/realtime?model=%@", model]]];
        [req setValue:[@"Bearer " stringByAppendingString:oai]
            forHTTPHeaderField:@"authorization"];
        NSURLSessionWebSocketTask *task = [NSURLSession.sharedSession webSocketTaskWithRequest:req];
        self.aiRtTask = task;
        [task resume];
        [self aiRtReceiveLoop:task];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.rtSend"]) {
        // JS가 만든 이벤트 JSON을 그대로 전송 (audio append, session.update 등)
        if (self.aiRtTask == nil || arg == nil) {
            [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
            return;
        }
        NSURLSessionWebSocketMessage *msg =
            [[NSURLSessionWebSocketMessage alloc] initWithString:arg];
        [self.aiRtTask sendMessage:msg completionHandler:^(NSError *error) { (void)error; }];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.rtStop"]) {
        [self.aiRtTask cancel];
        self.aiRtTask = nil;
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.notifRecent"]) {
        [self handleAINotif:a msgId:msgId];

    } else if ([cmd isEqualToString:@"ai.gmailRecent"]) {
        // Gmail IMAP 리더 (scripts/gmail_helper.py — 읽기 전용, 표준 라이브러리만)
        double hours = [a[@"hours"] isKindOfClass:[NSNumber class]]
            ? [a[@"hours"] doubleValue] : 48.0;
        NSString *helper = [OmniBaseDir()
            stringByAppendingPathComponent:@"scripts/gmail_helper.py"];
        NSString *creds = [NSHomeDirectory()
            stringByAppendingPathComponent:@".omni/gmail.key"];
        if (![NSFileManager.defaultManager fileExistsAtPath:creds]) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NEED_SETUP" } forId:msgId];
            return;
        }
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            NSTask *task = [[NSTask alloc] init];
            task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/python3"];
            task.arguments = @[ helper, creds,
                                [NSString stringWithFormat:@"%.1f", hours] ];
            NSPipe *outPipe = [NSPipe pipe];
            task.standardOutput = outPipe;
            task.standardError = [NSPipe pipe];
            NSError *err = nil;
            if (![task launchAndReturnError:&err]) {
                [self deliverPayload:@{ @"ok" : @NO,
                    @"error" : err.localizedDescription ?: @"helper launch" } forId:msgId];
                return;
            }
            NSData *outData = [outPipe.fileHandleForReading readDataToEndOfFile];
            [task waitUntilExit];
            id parsed = outData.length
                ? [NSJSONSerialization JSONObjectWithData:outData options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) {
                [self deliverPayload:parsed forId:msgId];
            } else {
                [self deliverPayload:@{ @"ok" : @NO, @"error" : @"helper output" }
                               forId:msgId];
            }
        });

    } else if ([cmd hasPrefix:@"ai.fs"]) {
        [self handleAIFs:cmd a:a msgId:msgId];

    } else if ([cmd isEqualToString:@"ai.chat"]) {
        NSString *key = OmniAIReadKey();
        if (key == nil) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NO_KEY" } forId:msgId];
            return;
        }
        NSString *model = [a[@"model"] isKindOfClass:[NSString class]]
            ? a[@"model"] : @"claude-haiku-4-5-20251001";
        // system은 문자열 또는 블록 배열(프롬프트 캐싱 cache_control 포함) 허용
        id system = ([a[@"system"] isKindOfClass:[NSString class]]
                     || [a[@"system"] isKindOfClass:[NSArray class]]) ? a[@"system"] : @"";
        NSArray *messages = [a[@"messages"] isKindOfClass:[NSArray class]] ? a[@"messages"] : @[];
        NSNumber *maxTok = [a[@"maxTokens"] isKindOfClass:[NSNumber class]]
            ? a[@"maxTokens"] : @400;
        NSMutableDictionary *body = [@{ @"model" : model,
                                        @"max_tokens" : maxTok,
                                        @"system" : system,
                                        @"messages" : messages } mutableCopy];
        // 파일 도구 등 tool use 지원 — 도구 정의는 JS가 전달
        if ([a[@"tools"] isKindOfClass:[NSArray class]]) body[@"tools"] = a[@"tools"];
        NSData *bodyData = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
        if (bodyData == nil) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"bad request" } forId:msgId];
            return;
        }
        NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:
            [NSURL URLWithString:@"https://api.anthropic.com/v1/messages"]];
        req.HTTPMethod = @"POST";
        req.HTTPBody = bodyData;
        req.timeoutInterval = 60;
        [req setValue:@"application/json" forHTTPHeaderField:@"content-type"];
        [req setValue:key forHTTPHeaderField:@"x-api-key"];
        [req setValue:@"2023-06-01" forHTTPHeaderField:@"anthropic-version"];
        [[NSURLSession.sharedSession dataTaskWithRequest:req
            completionHandler:^(NSData *data, NSURLResponse *resp, NSError *error) {
            if (error != nil) {
                [self deliverPayload:@{ @"ok" : @NO,
                    @"error" : error.localizedDescription ?: @"network" } forId:msgId];
                return;
            }
            id parsed = data ? [NSJSONSerialization JSONObjectWithData:data
                                                               options:0 error:nil] : nil;
            NSDictionary *r = [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
            NSInteger status = [(NSHTTPURLResponse *)resp statusCode];
            if (status != 200 || r == nil) {
                NSString *msg = @"";
                if ([r[@"error"] isKindOfClass:[NSDictionary class]]) {
                    msg = [r[@"error"][@"message"] isKindOfClass:[NSString class]]
                        ? r[@"error"][@"message"] : @"";
                }
                [self deliverPayload:@{ @"ok" : @NO,
                    @"error" : [NSString stringWithFormat:@"HTTP %ld %@", (long)status, msg] }
                               forId:msgId];
                return;
            }
            NSMutableString *text = [NSMutableString string];
            NSArray *content = [r[@"content"] isKindOfClass:[NSArray class]]
                ? r[@"content"] : @[];
            for (NSDictionary *item in content) {
                if ([item isKindOfClass:[NSDictionary class]]
                    && [item[@"text"] isKindOfClass:[NSString class]]) {
                    [text appendString:item[@"text"]];
                }
            }
            // 에이전트 루프용: content 블록 배열 + stop_reason 그대로 전달
            [self deliverPayload:@{ @"ok" : @YES,
                                    @"text" : text,
                                    @"content" : content,
                                    @"stop" : r[@"stop_reason"] ?: @"" } forId:msgId];
        }] resume];

    } else if ([cmd isEqualToString:@"ai.speak"]) {
        NSString *text = [a[@"text"] isKindOfClass:[NSString class]] ? a[@"text"] : @"";
        if (text.length == 0 || text.length > 2000) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"bad text" } forId:msgId];
            return;
        }
        // 클린 보이스 모드: 변조 없이 언어별 최고 품질 시스템 보이스로 바로 낭독.
        // (로봇 변조 파이프라인은 코드로 유지하되 neural 요청을 받지 않아 휴면)
        BOOL wantNeural = NO;
        NSString *lang = [a[@"lang"] isKindOfClass:[NSString class]] ? a[@"lang"] : @"ko";
        NSDictionary *voices = @{
            @"ko" : @"Yuna",
            @"en" : @"Samantha",
            @"ja" : @"Kyoko",
            @"zh" : @"Tingting",
            @"es" : @"Mónica",
            @"ru" : @"Milena",
        };
        // 속도: 보이스 기본 속도(0 = -r 생략)가 가장 자연스럽다
        NSNumber *rate = [a[@"rate"] isKindOfClass:[NSNumber class]] ? a[@"rate"] : @0;

        if (wantNeural && OmniAINeuralAvailable()) {
            // 신경망 경로: say 소스 → 대사팩 음색 변환.
            // 한국어는 kNN(음소 공간 일치, 0.6초), 비한국어는 Seed-VC(발음 보존, ~4초)
            BOOL useSeed = ![lang isEqualToString:@"ko"] && OmniAISeedAvailable();
            if ((useSeed ? self.aiSeedPendingId : self.aiTtsPendingId) != nil) {
                [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NEURAL_BUSY" } forId:msgId];
                return;
            }
            NSString *base = [NSTemporaryDirectory() stringByAppendingPathComponent:
                [NSString stringWithFormat:@"omni_ai_%@", NSUUID.UUID.UUIDString]];
            NSString *tmpIn = [base stringByAppendingString:@"_src.wav"];
            NSString *tmpOut = [base stringByAppendingString:@"_vc.wav"];
            __weak AppDelegate *weakSelf = self;
            NSString *srcVoice = voices[lang] ?: voices[@"ko"];
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                BOOL said = [weakSelf aiRunSay:text
                                         voice:srcVoice
                                          rate:rate toFile:tmpIn];
                dispatch_async(dispatch_get_main_queue(), ^{
                    AppDelegate *s = weakSelf;
                    if (s == nil) return;
                    if (!said) {
                        [s deliverPayload:@{ @"ok" : @NO, @"error" : @"NEURAL_FAIL" }
                                    forId:msgId];
                        return;
                    }
                    if (useSeed) {
                        [s aiSeedEnsure:^(BOOL ready) {
                            if (!ready || s.aiSeedPendingId != nil) {
                                [NSFileManager.defaultManager removeItemAtPath:tmpIn error:nil];
                                [s deliverPayload:@{ @"ok" : @NO, @"error" : @"NEURAL_FAIL" }
                                            forId:msgId];
                                return;
                            }
                            s.aiSeedPendingId = msgId;
                            s.aiSeedPendingIn = tmpIn;
                            s.aiSeedPendingOut = tmpOut;
                            NSData *req = [NSJSONSerialization dataWithJSONObject:
                                @{ @"in" : tmpIn, @"out" : tmpOut } options:0 error:nil];
                            NSMutableData *line = [req mutableCopy];
                            [line appendBytes:"\n" length:1];
                            @try {
                                [s.aiSeedIn.fileHandleForWriting writeData:line];
                            } @catch (NSException *e) {
                                [s aiSeedFailPending];
                                return;
                            }
                            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 90 * NSEC_PER_SEC),
                                           dispatch_get_main_queue(), ^{
                                if ([s.aiSeedPendingId isEqualToNumber:msgId]) {
                                    [s aiSeedFailPending];
                                }
                            });
                        }];
                        return;
                    }
                    [s aiTtsEnsure:^(BOOL ready) {
                        if (!ready || s.aiTtsPendingId != nil) {
                            [NSFileManager.defaultManager removeItemAtPath:tmpIn error:nil];
                            [s deliverPayload:@{ @"ok" : @NO, @"error" : @"NEURAL_FAIL" }
                                        forId:msgId];
                            return;
                        }
                        s.aiTtsPendingId = msgId;
                        s.aiTtsPendingIn = tmpIn;
                        s.aiTtsPendingOut = tmpOut;
                        NSData *req = [NSJSONSerialization dataWithJSONObject:
                            @{ @"in" : tmpIn, @"out" : tmpOut, @"lang" : lang }
                            options:0 error:nil];
                        NSMutableData *line = [req mutableCopy];
                        [line appendBytes:"\n" length:1];
                        @try {
                            [s.aiTtsIn.fileHandleForWriting writeData:line];
                        } @catch (NSException *e) {
                            [s aiTtsFailPending:@"pipe closed"];
                            return;
                        }
                        // 30초 타임아웃 — 응답이 늦으면 실패 처리 (늦은 응답은 무시됨)
                        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC),
                                       dispatch_get_main_queue(), ^{
                            if ([s.aiTtsPendingId isEqualToNumber:msgId]) {
                                [s aiTtsFailPending:@"timeout"];
                            }
                        });
                    }];
                });
            });
            return;
        }

        NSString *voice = [a[@"voice"] isKindOfClass:[NSString class]] ? a[@"voice"]
            : (voices[lang] ?: @"Yuna");
        // GPT 보이스 우선 (gpt-4o-mini-tts — 리얼타임 계열 음성, 다국어 자동) —
        // 키가 없거나 요청이 실패하면 시스템 보이스로 폴백
        NSString *oaiKey = OmniAIOpenAIKey();
        if (oaiKey != nil) {
            NSString *gptVoice = [a[@"gptVoice"] isKindOfClass:[NSString class]]
                ? a[@"gptVoice"] : @"onyx"; // 사용자 선택 (저음 남성)
            NSDictionary *body = @{
                @"model" : @"gpt-4o-mini-tts",
                @"voice" : gptVoice,
                @"input" : text,
                @"instructions" :
                    @"차분하고 명료한 관제 AI 어조. 담백한 보고체로, 과장 없이 또렷하게. "
                    @"입력 텍스트의 언어 그대로 읽는다.",
                @"response_format" : @"wav",
            };
            NSData *bodyData = [NSJSONSerialization dataWithJSONObject:body
                                                               options:0 error:nil];
            NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:
                [NSURL URLWithString:@"https://api.openai.com/v1/audio/speech"]];
            req.HTTPMethod = @"POST";
            req.HTTPBody = bodyData;
            req.timeoutInterval = 45;
            [req setValue:@"application/json" forHTTPHeaderField:@"content-type"];
            [req setValue:[@"Bearer " stringByAppendingString:oaiKey]
                forHTTPHeaderField:@"authorization"];
            __weak AppDelegate *weakSelf = self;
            [[NSURLSession.sharedSession dataTaskWithRequest:req
                completionHandler:^(NSData *data, NSURLResponse *resp, NSError *error) {
                NSInteger status = [(NSHTTPURLResponse *)resp statusCode];
                BOOL isWav = data.length > 1000
                    && memcmp(data.bytes, "RIFF", 4) == 0;
                if (error == nil && status == 200 && isWav) {
                    [weakSelf deliverPayload:@{ @"ok" : @YES, @"neural" : @NO,
                        @"engine" : @"gpt",
                        @"wav" : [data base64EncodedStringWithOptions:0] } forId:msgId];
                } else {
                    [weakSelf aiSpeakSay:text voice:voice rate:rate msgId:msgId];
                }
            }] resume];
            return;
        }
        [self aiSpeakSay:text voice:voice rate:rate msgId:msgId];
    }
}

// 시스템 보이스(say) 클린 발화 — GPT 보이스 폴백 겸 기본 경로
- (void)aiSpeakSay:(NSString *)text voice:(NSString *)voice rate:(NSNumber *)rate
             msgId:(NSNumber *)msgId {
    __weak AppDelegate *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSString *tmp = [NSTemporaryDirectory() stringByAppendingPathComponent:
            [NSString stringWithFormat:@"omni_ai_tts_%@.wav", NSUUID.UUID.UUIDString]];
        BOOL said = [weakSelf aiRunSay:text voice:voice rate:rate toFile:tmp];
        NSData *wav = said ? [NSData dataWithContentsOfFile:tmp] : nil;
        [NSFileManager.defaultManager removeItemAtPath:tmp error:nil];
        if (wav.length == 0) {
            [weakSelf deliverPayload:@{ @"ok" : @NO, @"error" : @"tts failed" }
                               forId:msgId];
            return;
        }
        [weakSelf deliverPayload:@{ @"ok" : @YES, @"neural" : @NO,
                                    @"engine" : @"say",
                                    @"wav" : [wav base64EncodedStringWithOptions:0] }
                           forId:msgId];
    });
}

- (void)deliverPayload:(NSDictionary *)payload forId:(NSNumber *)msgId {
    NSError *err = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&err];
    if (json == nil) {
        NSLog(@"bridge: JSON encode failed: %@", err);
        return;
    }
    NSMutableString *jsonStr = [[[NSString alloc] initWithData:json
                                                      encoding:NSUTF8StringEncoding] mutableCopy];
    // U+2028/U+2029 are valid JSON but not valid inline JS — escape them.
    [jsonStr replaceOccurrencesOfString:[NSString stringWithFormat:@"%C", (unichar)0x2028]
                             withString:@"\\u2028"
                                options:0 range:NSMakeRange(0, jsonStr.length)];
    [jsonStr replaceOccurrencesOfString:[NSString stringWithFormat:@"%C", (unichar)0x2029]
                             withString:@"\\u2029"
                                options:0 range:NSMakeRange(0, jsonStr.length)];
    NSString *js = [NSString stringWithFormat:
        @"window.OmniNative && window.OmniNative._deliver(%@, %@)", msgId, jsonStr];
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.webView evaluateJavaScript:js completionHandler:nil];
    });
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];

        // Minimal menu so Cmd+Q / Cmd+W / Cmd+M work.
        NSMenu *mainMenu = [NSMenu new];
        NSMenuItem *appMenuItem = [NSMenuItem new];
        [mainMenu addItem:appMenuItem];
        NSMenu *appMenu = [NSMenu new];
        [appMenu addItemWithTitle:@"Hide OMNI_OS" action:@selector(hide:) keyEquivalent:@"h"];
        [appMenu addItem:[NSMenuItem separatorItem]];
        [appMenu addItemWithTitle:@"Quit OMNI_OS" action:@selector(terminate:) keyEquivalent:@"q"];
        appMenuItem.submenu = appMenu;

        // Edit menu — Cmd+C/V/X/A/Z가 이 메뉴의 key equivalent로 동작한다.
        // 표준 셀렉터라 웹뷰(입력 필드, CodeMirror)까지 리스폰더 체인으로 전달됨
        NSMenuItem *editMenuItem = [NSMenuItem new];
        [mainMenu addItem:editMenuItem];
        NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
        [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
        [editMenu addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
        [editMenu addItem:[NSMenuItem separatorItem]];
        [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
        [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
        [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
        [editMenu addItem:[NSMenuItem separatorItem]];
        [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:)
                     keyEquivalent:@"a"];
        editMenuItem.submenu = editMenu;

        NSMenuItem *windowMenuItem = [NSMenuItem new];
        [mainMenu addItem:windowMenuItem];
        NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
        [windowMenu addItemWithTitle:@"Close" action:@selector(performClose:) keyEquivalent:@"w"];
        [windowMenu addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
        windowMenuItem.submenu = windowMenu;
        app.mainMenu = mainMenu;

        AppDelegate *delegate = [AppDelegate new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
