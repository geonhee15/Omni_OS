#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <EventKit/EventKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
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

@interface AppDelegate : NSObject <NSApplicationDelegate, WKScriptMessageHandler,
                                   WKUIDelegate, NSURLSessionDataDelegate>
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
// 오미니아 — 로컬 LLM(Ollama) 스트리밍 세션
@property (strong) NSURLSession *omniaSession;
@property (strong) EKEventStore *eventStore;
@property (strong) NSTask *gateTask;          // 음성 게이트 사이드카 (scripts/omni_gate.py)
@property (strong) NSFileHandle *gateIn;
@property (strong) NSMutableData *gateBuf;
@property (strong) dispatch_queue_t gateWriteQ;      // 사이드카 stdin 직렬화
@property (strong) AVAudioEngine *gateEngine;        // 마이크 캡처 (16k mono int16)
@property (strong) AVAudioConverter *gateMicConv;
@property (strong) AVAudioFormat *gateMicOut;
@property AudioObjectID gateTapID;                   // 시스템 출력 루프백 (Core Audio process tap)
@property AudioObjectID gateAggID;
@property AudioDeviceIOProcID gateIOProc;
@property double gateTapRate;
@property BOOL gateTapOK;
@property (strong) NSNumber *omniaTurn;
@property (strong) NSMutableString *omniaBuf;
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
    [self gateStop];
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
        NSArray *allowed = @[ @"com.kakao.KakaoTalkMac", @"com.apple.mail",
                              @"com.hnc.Discord" ];
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
    } else if ([cmd isEqualToString:@"net.get"]) {
        // 패널용 HTTP GET 프록시 — WKWebView의 CORS 제약을 우회한다.
        // 허용 호스트만(날씨·지오코딩·뉴스 RSS·지도 검색·IP 위치), https 한정.
        NSString *urlStr = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]
                && [parsed[@"url"] isKindOfClass:[NSString class]]) {
                urlStr = parsed[@"url"];
            }
        }
        static NSArray *allow = nil;
        if (allow == nil) {
            allow = @[ @"api.open-meteo.com", @"geocoding-api.open-meteo.com",
                       @"news.google.com", @"nominatim.openstreetmap.org",
                       @"ipwho.is", @"get.geojs.io",
                       @"open.er-api.com", @"query1.finance.yahoo.com" ];
        }
        NSURL *url = urlStr ? [NSURL URLWithString:urlStr] : nil;
        if (url == nil || ![url.scheme isEqualToString:@"https"]
            || ![allow containsObject:url.host.lowercaseString]) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"HOST_NOT_ALLOWED" }
                           forId:msgId];
            return;
        }
        NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
        req.timeoutInterval = 15;
        [req setValue:@"Mozilla/5.0 OmniOS/0.61 (personal desktop HUD)"
            forHTTPHeaderField:@"User-Agent"];
        [req setValue:@"ko-KR,ko;q=0.9,en;q=0.6" forHTTPHeaderField:@"Accept-Language"];
        [[NSURLSession.sharedSession dataTaskWithRequest:req
            completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
            if (err != nil || data == nil) {
                [self deliverPayload:@{ @"ok" : @NO,
                    @"error" : err.localizedDescription ?: @"network" } forId:msgId];
                return;
            }
            NSInteger status = [resp isKindOfClass:[NSHTTPURLResponse class]]
                ? ((NSHTTPURLResponse *)resp).statusCode : 0;
            NSString *body = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
                ?: @"";
            [self deliverPayload:@{ @"ok" : @(status > 0 && status < 400),
                                    @"status" : @(status), @"body" : body } forId:msgId];
        }] resume];
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
    } else if ([cmd hasPrefix:@"cu."]) {
        NSDictionary *ca = @{};
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) ca = parsed;
        }
        [self handleCU:cmd a:ca msgId:msgId];
    } else if ([cmd hasPrefix:@"mem."]) {
        NSDictionary *ma = @{};
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) ma = parsed;
        }
        [self handleMem:cmd a:ma msgId:msgId];
    } else if ([cmd hasPrefix:@"cal."]) {
        [self handleCal:cmd arg:arg msgId:msgId];
    } else if ([cmd hasPrefix:@"ai."] || [cmd hasPrefix:@"omnia."]) {
        // 오미니아(omnia.*) 명령도 같은 핸들러에서 처리한다 — 접두사가 달라
        // 분기에 도달하지 못하던 문제 수정
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

// ---- 오미니아 스트리밍 수신 (Ollama NDJSON) ----
// 줄 단위 JSON을 파싱해 토큰을 즉시 OmniaAI._tok 으로, 종료 시 _done 으로 푸시

- (void)omniaPushJS:(NSString *)js {
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.webView evaluateJavaScript:js completionHandler:nil];
    });
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data {
    if (session != self.omniaSession) return;
    NSString *chunk = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (chunk == nil) return;
    [self.omniaBuf appendString:chunk];
    NSRange nl;
    while ((nl = [self.omniaBuf rangeOfString:@"\n"]).location != NSNotFound) {
        NSString *line = [self.omniaBuf substringToIndex:nl.location];
        [self.omniaBuf deleteCharactersInRange:NSMakeRange(0, nl.location + 1)];
        NSData *ld = [line dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = ld.length ? [NSJSONSerialization JSONObjectWithData:ld
                                                                options:0 error:nil] : nil;
        if (![parsed isKindOfClass:[NSDictionary class]]) continue;
        NSDictionary *msg = [parsed[@"message"] isKindOfClass:[NSDictionary class]]
            ? parsed[@"message"] : nil;
        NSString *tok = [msg[@"content"] isKindOfClass:[NSString class]]
            ? msg[@"content"] : nil;
        if (tok.length > 0) {
            NSData *safe = [NSJSONSerialization dataWithJSONObject:@{ @"t" : tok }
                                                          options:0 error:nil];
            NSString *json = [[NSString alloc] initWithData:safe encoding:NSUTF8StringEncoding];
            [self omniaPushJS:[NSString stringWithFormat:
                @"window.OmniaAI && OmniaAI._tok(%@, %@)", json, self.omniaTurn ?: @0]];
        }
        if ([parsed[@"done"] boolValue]) {
            [self omniaPushJS:[NSString stringWithFormat:
                @"window.OmniaAI && OmniaAI._done(%@)", self.omniaTurn ?: @0]];
        }
    }
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error {
    if (session != self.omniaSession) return;
    if (error != nil) {
        NSData *safe = [NSJSONSerialization dataWithJSONObject:
            @{ @"e" : error.localizedDescription ?: @"error" } options:0 error:nil];
        NSString *json = [[NSString alloc] initWithData:safe encoding:NSUTF8StringEncoding];
        [self omniaPushJS:[NSString stringWithFormat:
            @"window.OmniaAI && OmniaAI._err(%@, %@)", json, self.omniaTurn ?: @0]];
    } else {
        [self omniaPushJS:[NSString stringWithFormat:
            @"window.OmniaAI && OmniaAI._done(%@)", self.omniaTurn ?: @0]];
    }
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
        // 원본을 읽기 전용으로 열면 WAL(-wal)이 반영되지 않아 최신 알림이 보이지
        // 않는다. db/-wal/-shm 을 임시 폴더로 복사한 뒤 그 사본을 열어 WAL을
        // 재생시킨다 (원본은 절대 건드리지 않음).
        NSFileManager *fmc = NSFileManager.defaultManager;
        NSString *tmpDir = [NSTemporaryDirectory() stringByAppendingPathComponent:
            [NSString stringWithFormat:@"omni_notif_%@", NSUUID.UUID.UUIDString]];
        [fmc createDirectoryAtPath:tmpDir withIntermediateDirectories:YES
                        attributes:nil error:nil];
        NSString *copyPath = [tmpDir stringByAppendingPathComponent:@"db"];
        for (NSString *suffix in @[ @"", @"-wal", @"-shm" ]) {
            NSString *src = [dbPath stringByAppendingString:suffix];
            NSString *dst = [copyPath stringByAppendingString:suffix];
            [fmc copyItemAtPath:src toPath:dst error:nil]; // -wal/-shm은 없을 수도 있음
        }
        sqlite3 *db = NULL;
        if (sqlite3_open_v2(copyPath.UTF8String, &db,
                SQLITE_OPEN_READWRITE, NULL) != SQLITE_OK) {
            NSString *msg = db != NULL
                ? [NSString stringWithFormat:@"SQLITE: %s", sqlite3_errmsg(db)]
                : @"SQLITE: open failed";
            if (db != NULL) sqlite3_close(db);
            [fmc removeItemAtPath:tmpDir error:nil];
            [self deliverPayload:@{ @"ok" : @NO, @"error" : msg } forId:msgId];
            return;
        }
        // Core Data 타임스탬프(2001-01-01 기준 초) 컷오프
        double cutoff = [NSDate.date timeIntervalSinceReferenceDate] - hours * 3600.0;
        NSMutableArray *out = [NSMutableArray array];
        NSMutableSet *seen = [NSMutableSet set];       // 테이블 간 중복 제거
        NSMutableSet *appsSeen = [NSMutableSet set];   // 진단용 — 감지된 앱 목록

        // 알림은 상태에 따라 여러 테이블에 나뉘어 있다 (읽지 않은 것은 record에
        // 없고 delivered/displayed에만 있는 경우가 있음) — 존재하는 테이블을
        // 모두 훑는다. 날짜 컬럼명도 버전마다 달라 후보를 순회한다.
        NSArray *tables = @[ @"record", @"delivered", @"displayed", @"requests" ];
        NSArray *dateCols = @[ @"delivered_date", @"presented_date", @"date", @"request_date" ];
        for (NSString *table in tables) {
            for (NSString *dateCol in dateCols) {
                NSString *sql = [NSString stringWithFormat:
                    @"SELECT app.identifier, t.%@, t.data FROM %@ t "
                    @"JOIN app ON t.app_id = app.app_id "
                    @"WHERE t.%@ > ? ORDER BY t.%@ DESC LIMIT 300",
                    dateCol, table, dateCol, dateCol];
                sqlite3_stmt *stmt = NULL;
                if (sqlite3_prepare_v2(db, sql.UTF8String, -1, &stmt, NULL) != SQLITE_OK) {
                    if (stmt != NULL) sqlite3_finalize(stmt);
                    continue; // 이 테이블/컬럼 조합은 없음 — 다음 후보
                }
                sqlite3_bind_double(stmt, 1, cutoff);
                while (sqlite3_step(stmt) == SQLITE_ROW && out.count < 150) {
                    const char *ident = (const char *)sqlite3_column_text(stmt, 0);
                    NSString *app = ident ? [NSString stringWithUTF8String:ident] : @"";
                    [appsSeen addObject:app];
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
                        // 표준 위치(req) 우선, 없으면 최상위 — 앱마다 구조가 다름
                        NSDictionary *req = [plist[@"req"] isKindOfClass:[NSDictionary class]]
                            ? plist[@"req"]
                            : ([plist isKindOfClass:[NSDictionary class]] ? plist : @{});
                        NSArray *titleKeys = @[ @"titl", @"title", @"tite" ];
                        NSArray *subKeys = @[ @"subt", @"subtitle" ];
                        NSArray *bodyKeys = @[ @"body", @"mesg", @"message", @"text" ];
                        for (NSString *k in titleKeys) {
                            if ([req[k] isKindOfClass:[NSString class]]
                                && [req[k] length] > 0) { title = req[k]; break; }
                        }
                        for (NSString *k in subKeys) {
                            if ([req[k] isKindOfClass:[NSString class]]
                                && [req[k] length] > 0) { subtitle = req[k]; break; }
                        }
                        for (NSString *k in bodyKeys) {
                            if ([req[k] isKindOfClass:[NSString class]]
                                && [req[k] length] > 0) { body = req[k]; break; }
                        }
                    }
                    // 제목·본문이 모두 비어도 앱 필터가 지정된 조회에서는 남긴다
                    // (내용 없는 알림도 "왔다"는 사실 자체가 정보)
                    if (title.length == 0 && body.length == 0) {
                        if (bundle.length == 0) continue;
                        body = @"(내용 없음)";
                    }
                    NSString *key = [NSString stringWithFormat:@"%@|%.0f|%@|%@",
                                     app, ts, title, body];
                    if ([seen containsObject:key]) continue;
                    [seen addObject:key];
                    [out addObject:@{ @"app" : app,
                                      @"ts" : @(ts + NSTimeIntervalSince1970),
                                      @"title" : title, @"subtitle" : subtitle,
                                      @"body" : body }];
                }
                sqlite3_finalize(stmt);
                break; // 이 테이블은 처리 완료 — 다음 테이블로
            }
        }
        // 여러 테이블을 합쳤으므로 최신순으로 재정렬
        [out sortUsingComparator:^NSComparisonResult(NSDictionary *x, NSDictionary *y) {
            return [(NSNumber *)y[@"ts"] compare:(NSNumber *)x[@"ts"]];
        }];
        sqlite3_close(db);
        [fmc removeItemAtPath:tmpDir error:nil];
        [self deliverPayload:@{ @"ok" : @YES, @"items" : out,
                                @"apps" : appsSeen.allObjects } forId:msgId];
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

#pragma mark - COMPUTER USE (마우스·키보드·화면 — 옴니가 맥을 직접 조작)

// 좌표 규약: JS는 마지막 스크린샷 픽셀 좌표로 보내고, 여기서 화면 포인트로 환산한다.
static CGFloat gCuScale = 1.0;   // 스크린샷 px / 화면 pt

static CGKeyCode OmniKeyCode(NSString *name) {
    static NSDictionary *map = nil;
    if (map == nil) {
        map = @{ @"a":@0, @"s":@1, @"d":@2, @"f":@3, @"h":@4, @"g":@5, @"z":@6, @"x":@7, @"c":@8, @"v":@9,
                 @"b":@11, @"q":@12, @"w":@13, @"e":@14, @"r":@15, @"y":@16, @"t":@17, @"1":@18, @"2":@19,
                 @"3":@20, @"4":@21, @"6":@22, @"5":@23, @"=":@24, @"9":@25, @"7":@26, @"-":@27, @"8":@28,
                 @"0":@29, @"]":@30, @"o":@31, @"u":@32, @"[":@33, @"i":@34, @"p":@35, @"enter":@36, @"return":@36,
                 @"l":@37, @"j":@38, @"'":@39, @"k":@40, @";":@41, @"\\":@42, @",":@43, @"/":@44, @"n":@45,
                 @"m":@46, @".":@47, @"tab":@48, @"space":@49, @"`":@50, @"backspace":@51, @"delete":@51,
                 @"esc":@53, @"escape":@53, @"f1":@122, @"f2":@120, @"f3":@99, @"f4":@118, @"f5":@96,
                 @"f6":@97, @"f7":@98, @"f8":@100, @"f9":@101, @"f10":@109, @"f11":@103, @"f12":@111,
                 @"home":@115, @"pageup":@116, @"forwarddelete":@117, @"end":@119, @"pagedown":@121,
                 @"left":@123, @"right":@124, @"down":@125, @"up":@126 };
    }
    NSNumber *n = map[name.lowercaseString];
    return n ? (CGKeyCode)n.unsignedShortValue : (CGKeyCode)0xFFFF;
}

static CGPoint OmniCuPoint(NSDictionary *a, NSString *kx, NSString *ky) {
    double x = [a[kx] isKindOfClass:[NSNumber class]] ? [a[kx] doubleValue] : 0;
    double y = [a[ky] isKindOfClass:[NSNumber class]] ? [a[ky] doubleValue] : 0;
    if (![a[@"space"] isKindOfClass:[NSString class]] || ![a[@"space"] isEqualToString:@"pt"]) {
        x /= gCuScale; y /= gCuScale;   // 스크린샷 px → 포인트
    }
    return CGPointMake(x, y);
}

static void OmniCuPostMouse(CGEventType type, CGPoint p, CGMouseButton btn, int clickCount) {
    CGEventRef e = CGEventCreateMouseEvent(NULL, type, p, btn);
    if (clickCount > 1) CGEventSetIntegerValueField(e, kCGMouseEventClickState, clickCount);
    CGEventPost(kCGHIDEventTap, e);
    CFRelease(e);
}

static void OmniCuSleep(double sec) { usleep((useconds_t)(sec * 1e6)); }

// 현재 커서에서 목표까지 부드럽게 미끄러져 이동 (ease-out, ~120ms) — 급한 순간이동 대신 자연스러운 조작
static void OmniCuGlide(CGPoint to) {
    CGEventRef e = CGEventCreate(NULL);
    CGPoint from = CGEventGetLocation(e);
    CFRelease(e);
    double dist = hypot(to.x - from.x, to.y - from.y);
    int steps = (int)MIN(14, MAX(4, dist / 60.0));
    for (int i = 1; i <= steps; i++) {
        double t = (double)i / steps;
        double k = 1 - pow(1 - t, 2.2);              // ease-out
        CGPoint p = CGPointMake(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
        OmniCuPostMouse(kCGEventMouseMoved, p, kCGMouseButtonLeft, 1);
        OmniCuSleep(0.008);
    }
    OmniCuPostMouse(kCGEventMouseMoved, to, kCGMouseButtonLeft, 1);
}

// 앱 이름으로 실행/전면 (NSWorkspace) — 독 아이콘 좌표 추정보다 훨씬 확실
static BOOL OmniCuOpenApp(NSString *name) {
    NSWorkspace *ws = NSWorkspace.sharedWorkspace;
    for (NSRunningApplication *app in ws.runningApplications) {
        if (app.localizedName && [app.localizedName caseInsensitiveCompare:name] == NSOrderedSame) {
            return [app activateWithOptions:NSApplicationActivateAllWindows];
        }
    }
    NSArray *dirs = @[ @"/Applications", [NSHomeDirectory() stringByAppendingPathComponent:@"Applications"],
                       @"/System/Applications", @"/System/Applications/Utilities" ];
    for (NSString *d in dirs) {
        NSString *p = [d stringByAppendingPathComponent:[name stringByAppendingString:@".app"]];
        if ([NSFileManager.defaultManager fileExistsAtPath:p]) {
            NSURL *u = [NSURL fileURLWithPath:p];
            NSWorkspaceOpenConfiguration *cfg = [NSWorkspaceOpenConfiguration configuration];
            cfg.activates = YES;
            [ws openApplicationAtURL:u configuration:cfg completionHandler:nil];
            return YES;
        }
    }
    return [ws launchApplication:name];
}

- (void)handleCU:(NSString *)cmd a:(NSDictionary *)a msgId:(NSString *)msgId {
    if ([cmd isEqualToString:@"cu.status"]) {
        [self deliverPayload:@{ @"ok" : @YES,
                                @"accessibility" : @(AXIsProcessTrusted()),
                                @"screen" : @(CGPreflightScreenCaptureAccess()) } forId:msgId];
        return;
    }
    if ([cmd isEqualToString:@"cu.request"]) {
        // 권한 프롬프트 유도 (손쉬운 사용 / 화면 기록)
        NSDictionary *opts = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES };
        BOOL ax = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
        BOOL sc = CGPreflightScreenCaptureAccess();
        if (!sc) CGRequestScreenCaptureAccess();
        [self deliverPayload:@{ @"ok" : @YES, @"accessibility" : @(ax), @"screen" : @(sc) } forId:msgId];
        return;
    }
    if ([cmd isEqualToString:@"cu.apps"]) {
        // 실행 중인 앱 목록 + 전면 앱 — 조작 모듈의 상황 파악용
        NSMutableArray *names = [NSMutableArray array];
        for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
            if (app.activationPolicy == NSApplicationActivationPolicyRegular && app.localizedName.length) {
                [names addObject:app.localizedName];
            }
        }
        NSString *front = NSWorkspace.sharedWorkspace.frontmostApplication.localizedName ?: @"";
        [self deliverPayload:@{ @"ok" : @YES, @"apps" : names, @"front" : front } forId:msgId];
        return;
    }
    if ([cmd isEqualToString:@"cu.openApp"]) {
        NSString *name = [a[@"name"] isKindOfClass:[NSString class]] ? a[@"name"] : @"";
        BOOL ok = name.length > 0 && OmniCuOpenApp(name);
        [self deliverPayload:@{ @"ok" : @(ok), @"error" : ok ? @"" : @"APP_NOT_FOUND" } forId:msgId];
        return;
    }
    if ([cmd isEqualToString:@"cu.zoom"]) {
        // 스크린샷 픽셀 좌표의 영역을 원본 해상도로 잘라 확대 (작은 글자·아이콘 확인용)
        double zx = [a[@"x"] isKindOfClass:[NSNumber class]] ? [a[@"x"] doubleValue] : 0;
        double zy = [a[@"y"] isKindOfClass:[NSNumber class]] ? [a[@"y"] doubleValue] : 0;
        double zw = [a[@"w"] isKindOfClass:[NSNumber class]] ? [a[@"w"] doubleValue] : 300;
        double zh = [a[@"h"] isKindOfClass:[NSNumber class]] ? [a[@"h"] doubleValue] : 200;
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
            completionHandler:^(SCShareableContent *content, NSError *error) {
            SCDisplay *display = nil;
            for (SCDisplay *d in content.displays) if (d.displayID == CGMainDisplayID()) display = d;
            if (display == nil) display = content.displays.firstObject;
            if (error != nil || display == nil) {
                [self deliverPayload:@{ @"ok" : @NO, @"error" : @"SCREEN_DENIED" } forId:msgId];
                return;
            }
            double back = NSScreen.mainScreen.backingScaleFactor;
            // 스크린샷 px → 포인트 → 원본 px
            CGRect ptRect = CGRectMake(zx / gCuScale, zy / gCuScale, zw / gCuScale, zh / gCuScale);
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
            SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
            cfg.sourceRect = ptRect;
            cfg.width = (NSUInteger)(ptRect.size.width * back);
            cfg.height = (NSUInteger)(ptRect.size.height * back);
            cfg.showsCursor = NO;
            [SCScreenshotManager captureImageWithFilter:filter configuration:cfg
                completionHandler:^(CGImageRef img, NSError *err2) {
                if (err2 != nil || img == NULL) {
                    [self deliverPayload:@{ @"ok" : @NO, @"error" : err2.localizedDescription ?: @"ZOOM_FAILED" } forId:msgId];
                    return;
                }
                NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:img];
                NSData *jpg = [rep representationUsingType:NSBitmapImageFileTypeJPEG
                                                properties:@{ NSImageCompressionFactor : @0.85 }];
                [self deliverPayload:@{ @"ok" : @YES, @"jpeg" : [jpg base64EncodedStringWithOptions:0],
                                        @"w" : @(CGImageGetWidth(img)), @"h" : @(CGImageGetHeight(img)),
                                        @"x" : @(zx), @"y" : @(zy), @"zw" : @(zw), @"zh" : @(zh) } forId:msgId];
            }];
        }];
        return;
    }
    if ([cmd isEqualToString:@"cu.screenshot"]) {
        // ScreenCaptureKit (macOS 14+): 메인 디스플레이를 축소 캡처 → JPEG base64
        double maxW = [a[@"maxWidth"] isKindOfClass:[NSNumber class]] ? [a[@"maxWidth"] doubleValue] : 1280;
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
            completionHandler:^(SCShareableContent *content, NSError *error) {
            SCDisplay *display = nil;
            for (SCDisplay *d in content.displays) {
                if (d.displayID == CGMainDisplayID()) { display = d; break; }
            }
            if (display == nil) display = content.displays.firstObject;
            if (error != nil || display == nil) {
                [self deliverPayload:@{ @"ok" : @NO, @"error" : @"SCREEN_DENIED" } forId:msgId];
                return;
            }
            double ptW = display.width, ptH = display.height;             // 포인트
            double pxW = ptW * NSScreen.mainScreen.backingScaleFactor;
            double scaleDown = MIN(1.0, maxW / pxW);
            NSUInteger ow = (NSUInteger)(pxW * scaleDown);
            NSUInteger oh = (NSUInteger)(ptH * NSScreen.mainScreen.backingScaleFactor * scaleDown);
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
            SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
            cfg.width = ow; cfg.height = oh;
            cfg.showsCursor = YES;
            cfg.captureResolution = SCCaptureResolutionAutomatic;
            [SCScreenshotManager captureImageWithFilter:filter configuration:cfg
                completionHandler:^(CGImageRef img, NSError *err2) {
                if (err2 != nil || img == NULL) {
                    [self deliverPayload:@{ @"ok" : @NO,
                        @"error" : err2.localizedDescription ?: @"SCREEN_DENIED" } forId:msgId];
                    return;
                }
                NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:img];
                NSData *jpg = [rep representationUsingType:NSBitmapImageFileTypeJPEG
                                                properties:@{ NSImageCompressionFactor : @0.8 }];
                size_t w = CGImageGetWidth(img), h = CGImageGetHeight(img);
                gCuScale = (double)w / ptW;    // 스크린샷 px / 포인트
                [self deliverPayload:@{ @"ok" : @YES, @"jpeg" : [jpg base64EncodedStringWithOptions:0],
                                        @"w" : @(w), @"h" : @(h), @"scale" : @(gCuScale),
                                        @"screenW" : @(ptW), @"screenH" : @(ptH) } forId:msgId];
            }];
        }];
        return;
    }
    if (!AXIsProcessTrusted()) {
        [self deliverPayload:@{ @"ok" : @NO, @"error" : @"AX_DENIED" } forId:msgId];
        return;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        if ([cmd isEqualToString:@"cu.move"]) {
            CGPoint p = OmniCuPoint(a, @"x", @"y");
            OmniCuGlide(p);
        } else if ([cmd isEqualToString:@"cu.click"]) {
            CGPoint p = OmniCuPoint(a, @"x", @"y");
            NSString *btn = [a[@"button"] isKindOfClass:[NSString class]] ? a[@"button"] : @"left";
            int count = [a[@"count"] isKindOfClass:[NSNumber class]] ? [a[@"count"] intValue] : 1;
            BOOL right = [btn isEqualToString:@"right"];
            OmniCuGlide(p);                 // 부드럽게 이동 후
            OmniCuSleep(0.06);              // 잠깐 멈춰(호버) 클릭 — 침착한 조작
            for (int i = 1; i <= MAX(1, count); i++) {
                OmniCuPostMouse(right ? kCGEventRightMouseDown : kCGEventLeftMouseDown, p,
                                right ? kCGMouseButtonRight : kCGMouseButtonLeft, i);
                OmniCuSleep(0.04);
                OmniCuPostMouse(right ? kCGEventRightMouseUp : kCGEventLeftMouseUp, p,
                                right ? kCGMouseButtonRight : kCGMouseButtonLeft, i);
                OmniCuSleep(0.06);
            }
        } else if ([cmd isEqualToString:@"cu.drag"]) {
            CGPoint p1 = OmniCuPoint(a, @"x", @"y"), p2 = OmniCuPoint(a, @"x2", @"y2");
            OmniCuPostMouse(kCGEventMouseMoved, p1, kCGMouseButtonLeft, 1); OmniCuSleep(0.08);
            OmniCuPostMouse(kCGEventLeftMouseDown, p1, kCGMouseButtonLeft, 1); OmniCuSleep(0.1);
            for (int i = 1; i <= 12; i++) {
                CGPoint m = CGPointMake(p1.x + (p2.x - p1.x) * i / 12.0, p1.y + (p2.y - p1.y) * i / 12.0);
                OmniCuPostMouse(kCGEventLeftMouseDragged, m, kCGMouseButtonLeft, 1); OmniCuSleep(0.02);
            }
            OmniCuPostMouse(kCGEventLeftMouseUp, p2, kCGMouseButtonLeft, 1);
        } else if ([cmd isEqualToString:@"cu.scroll"]) {
            CGPoint p = OmniCuPoint(a, @"x", @"y");
            int dy = [a[@"dy"] isKindOfClass:[NSNumber class]] ? [a[@"dy"] intValue] : -5;
            int dx = [a[@"dx"] isKindOfClass:[NSNumber class]] ? [a[@"dx"] intValue] : 0;
            OmniCuPostMouse(kCGEventMouseMoved, p, kCGMouseButtonLeft, 1); OmniCuSleep(0.05);
            CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, dy, dx);
            CGEventPost(kCGHIDEventTap, e); CFRelease(e);
        } else if ([cmd isEqualToString:@"cu.type"]) {
            NSString *text = [a[@"text"] isKindOfClass:[NSString class]] ? a[@"text"] : @"";
            NSUInteger i = 0;
            while (i < text.length) {
                NSRange r = NSMakeRange(i, MIN(16u, (unsigned)(text.length - i)));
                r = [text rangeOfComposedCharacterSequencesForRange:r];
                NSString *chunk = [text substringWithRange:r];
                unichar buf[64]; NSUInteger len = MIN(chunk.length, 64u);
                [chunk getCharacters:buf range:NSMakeRange(0, len)];
                CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
                CGEventKeyboardSetUnicodeString(down, len, buf);
                CGEventPost(kCGHIDEventTap, down); CFRelease(down);
                CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
                CGEventKeyboardSetUnicodeString(up, len, buf);
                CGEventPost(kCGHIDEventTap, up); CFRelease(up);
                OmniCuSleep(0.03);
                i = r.location + r.length;
            }
        } else if ([cmd isEqualToString:@"cu.key"]) {
            // "cmd+shift+t", "enter", "ctrl+c" 등
            NSString *keys = [a[@"keys"] isKindOfClass:[NSString class]] ? a[@"keys"] : @"";
            CGEventFlags flags = 0; CGKeyCode code = 0xFFFF;
            for (NSString *part in [keys.lowercaseString componentsSeparatedByString:@"+"]) {
                NSString *k = [part stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
                if ([k isEqualToString:@"cmd"] || [k isEqualToString:@"command"]) flags |= kCGEventFlagMaskCommand;
                else if ([k isEqualToString:@"shift"]) flags |= kCGEventFlagMaskShift;
                else if ([k isEqualToString:@"alt"] || [k isEqualToString:@"option"]) flags |= kCGEventFlagMaskAlternate;
                else if ([k isEqualToString:@"ctrl"] || [k isEqualToString:@"control"]) flags |= kCGEventFlagMaskControl;
                else code = OmniKeyCode(k);
            }
            if (code != 0xFFFF) {
                CGEventRef down = CGEventCreateKeyboardEvent(NULL, code, true);
                CGEventSetFlags(down, flags); CGEventPost(kCGHIDEventTap, down); CFRelease(down);
                OmniCuSleep(0.04);
                CGEventRef up = CGEventCreateKeyboardEvent(NULL, code, false);
                CGEventSetFlags(up, flags); CGEventPost(kCGHIDEventTap, up); CFRelease(up);
            }
        } else {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"UNKNOWN_CMD" } forId:msgId];
            return;
        }
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
    });
}

#pragma mark - MEMORY (~/.omni/memory — 프로필·일지·다이제스트)

// 옴니의 기억 저장소. 앱(JS)·안경 브리지(파이썬)가 같은 파일을 쓴다.
//   profile.md                 오래가는 사실·선호 (통합본)
//   journal/YYYY-MM-DD.jsonl   시간순 일지: 대화·관찰·생각·행동
//   ambient/YYYY-MM-DD.jsonl   주변음 전사 원문 (분석 재료, 일지와 분리)
//   digests/YYYY-MM-DD.md      하루 요약
static NSString *OmniMemDir(void) {
    NSString *d = [NSHomeDirectory() stringByAppendingPathComponent:@".omni/memory"];
    NSFileManager *fm = NSFileManager.defaultManager;
    for (NSString *sub in @[ @"", @"journal", @"ambient", @"digests" ]) {
        [fm createDirectoryAtPath:[d stringByAppendingPathComponent:sub]
      withIntermediateDirectories:YES attributes:nil error:nil];
    }
    return d;
}

static NSString *OmniMemToday(void) {
    NSDateFormatter *df = [[NSDateFormatter alloc] init];
    df.dateFormat = @"yyyy-MM-dd";
    return [df stringFromDate:NSDate.date];
}

static BOOL OmniMemValidDate(NSString *d) {
    if (d.length != 10) return NO;
    NSCharacterSet *ok = [NSCharacterSet characterSetWithCharactersInString:@"0123456789-"];
    return [d rangeOfCharacterFromSet:ok.invertedSet].location == NSNotFound;
}

- (void)handleMem:(NSString *)cmd a:(NSDictionary *)a msgId:(NSString *)msgId {
    NSString *dir = OmniMemDir();
    NSFileManager *fm = NSFileManager.defaultManager;
    if ([cmd isEqualToString:@"mem.append"]) {
        NSString *kind = [a[@"kind"] isKindOfClass:[NSString class]] ? a[@"kind"] : @"note";
        NSString *text = [a[@"text"] isKindOfClass:[NSString class]] ? a[@"text"] : @"";
        if (text.length == 0) { [self deliverPayload:@{ @"ok" : @NO } forId:msgId]; return; }
        NSMutableDictionary *entry = [@{ @"ts" : @([NSDate.date timeIntervalSince1970]),
                                         @"kind" : kind, @"text" : text } mutableCopy];
        if ([a[@"tags"] isKindOfClass:[NSArray class]]) entry[@"tags"] = a[@"tags"];
        if ([a[@"meta"] isKindOfClass:[NSDictionary class]]) entry[@"meta"] = a[@"meta"];
        NSData *jd = [NSJSONSerialization dataWithJSONObject:entry options:0 error:nil];
        NSString *sub = [kind isEqualToString:@"ambient"] ? @"ambient" : @"journal";
        NSString *path = [[dir stringByAppendingPathComponent:sub]
            stringByAppendingPathComponent:[OmniMemToday() stringByAppendingString:@".jsonl"]];
        NSMutableData *line = [jd mutableCopy];
        [line appendBytes:"\n" length:1];
        NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:path];
        if (fh == nil) { [line writeToFile:path atomically:YES]; }
        else { [fh seekToEndOfFile]; [fh writeData:line]; [fh closeFile]; }
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"mem.read"]) {
        // 최근 N일 일지(+선택: 주변음) 항목 — 날짜순, 각 파일 끝에서 limit
        NSInteger days = [a[@"days"] isKindOfClass:[NSNumber class]] ? [a[@"days"] integerValue] : 1;
        NSInteger limit = [a[@"limit"] isKindOfClass:[NSNumber class]] ? [a[@"limit"] integerValue] : 400;
        NSString *sub = [a[@"ambient"] boolValue] ? @"ambient" : @"journal";
        NSMutableArray *out = [NSMutableArray array];
        NSDateFormatter *df = [[NSDateFormatter alloc] init];
        df.dateFormat = @"yyyy-MM-dd";
        for (NSInteger i = MAX(0, days - 1); i >= 0; i--) {
            NSString *date = [df stringFromDate:[NSDate dateWithTimeIntervalSinceNow:-86400.0 * i]];
            NSString *path = [[dir stringByAppendingPathComponent:sub]
                stringByAppendingPathComponent:[date stringByAppendingString:@".jsonl"]];
            NSString *content = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
            if (content.length == 0) continue;
            for (NSString *ln in [content componentsSeparatedByString:@"\n"]) {
                if (ln.length == 0) continue;
                id parsed = [NSJSONSerialization JSONObjectWithData:[ln dataUsingEncoding:NSUTF8StringEncoding]
                                                            options:0 error:nil];
                if ([parsed isKindOfClass:[NSDictionary class]]) [out addObject:parsed];
            }
        }
        if ((NSInteger)out.count > limit) {
            out = [[out subarrayWithRange:NSMakeRange(out.count - limit, limit)] mutableCopy];
        }
        [self deliverPayload:@{ @"ok" : @YES, @"items" : out } forId:msgId];

    } else if ([cmd isEqualToString:@"mem.profile"]) {
        NSString *path = [dir stringByAppendingPathComponent:@"profile.md"];
        NSString *text = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
        if (text == nil) {
            // 구버전 ai_memory.json → profile.md 이전
            NSString *old = [NSHomeDirectory() stringByAppendingPathComponent:@".omni/store/ai_memory.json"];
            NSData *od = [NSData dataWithContentsOfFile:old];
            id parsed = od ? [NSJSONSerialization JSONObjectWithData:od options:0 error:nil] : nil;
            text = ([parsed isKindOfClass:[NSDictionary class]] && [parsed[@"text"] isKindOfClass:[NSString class]])
                ? parsed[@"text"] : @"";
            if (text.length) [text writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
        }
        [self deliverPayload:@{ @"ok" : @YES, @"text" : text ?: @"" } forId:msgId];

    } else if ([cmd isEqualToString:@"mem.profileWrite"]) {
        NSString *text = [a[@"text"] isKindOfClass:[NSString class]] ? a[@"text"] : @"";
        NSString *path = [dir stringByAppendingPathComponent:@"profile.md"];
        BOOL ok = [text writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
        [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];

    } else if ([cmd isEqualToString:@"mem.digest"] || [cmd isEqualToString:@"mem.digestWrite"]) {
        NSString *date = [a[@"date"] isKindOfClass:[NSString class]] ? a[@"date"] : @"";
        if (!OmniMemValidDate(date)) { [self deliverPayload:@{ @"ok" : @NO, @"error" : @"BAD_DATE" } forId:msgId]; return; }
        NSString *path = [[dir stringByAppendingPathComponent:@"digests"]
            stringByAppendingPathComponent:[date stringByAppendingString:@".md"]];
        if ([cmd isEqualToString:@"mem.digest"]) {
            NSString *text = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
            [self deliverPayload:@{ @"ok" : @YES, @"text" : text ?: @"", @"exists" : @(text != nil) } forId:msgId];
        } else {
            NSString *text = [a[@"text"] isKindOfClass:[NSString class]] ? a[@"text"] : @"";
            BOOL ok = [text writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
            [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
        }

    } else if ([cmd isEqualToString:@"mem.dates"]) {
        // 일지가 있는 날짜 목록 + 다이제스트 유무
        NSArray *files = [fm contentsOfDirectoryAtPath:[dir stringByAppendingPathComponent:@"journal"] error:nil];
        NSMutableArray *out = [NSMutableArray array];
        for (NSString *f in [files sortedArrayUsingSelector:@selector(compare:)]) {
            if (![f hasSuffix:@".jsonl"]) continue;
            NSString *date = [f stringByDeletingPathExtension];
            NSString *dg = [[dir stringByAppendingPathComponent:@"digests"]
                stringByAppendingPathComponent:[date stringByAppendingString:@".md"]];
            [out addObject:@{ @"date" : date, @"digest" : @([fm fileExistsAtPath:dg]) }];
        }
        [self deliverPayload:@{ @"ok" : @YES, @"dates" : out } forId:msgId];
    } else {
        [self deliverPayload:@{ @"ok" : @NO, @"error" : @"UNKNOWN_CMD" } forId:msgId];
    }
}

#pragma mark - JS 다이얼로그 (WKUIDelegate) — prompt/confirm/alert를 네이티브 NSAlert로

// WKWebView는 이 핸들러가 없으면 prompt()가 null, confirm()이 false를 즉시 돌려준다.
// HUD 톤에 맞춘 최소한의 NSAlert로 구현 (메인 스레드 콜백, 동기 runModal).
static NSAlert *OmniMakeAlert(NSString *message, NSString *okTitle, BOOL cancel) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"OMNI_OS";
    alert.informativeText = message ?: @"";
    alert.alertStyle = NSAlertStyleInformational;
    [alert addButtonWithTitle:okTitle ?: @"OK"];
    if (cancel) [alert addButtonWithTitle:@"CANCEL"];
    return alert;
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message
        initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    (void)webView; (void)frame;
    NSAlert *alert = OmniMakeAlert(message, @"OK", NO);
    [alert runModal];
    completionHandler();
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
        initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    (void)webView; (void)frame;
    NSAlert *alert = OmniMakeAlert(message, @"OK", YES);
    completionHandler([alert runModal] == NSAlertFirstButtonReturn);
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
        defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame
        completionHandler:(void (^)(NSString *))completionHandler {
    (void)webView; (void)frame;
    NSAlert *alert = OmniMakeAlert(prompt, @"OK", YES);
    NSTextField *field = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 260, 24)];
    field.stringValue = defaultText ?: @"";
    alert.accessoryView = field;
    alert.window.initialFirstResponder = field;
    if ([alert runModal] == NSAlertFirstButtonReturn) {
        completionHandler(field.stringValue);
    } else {
        completionHandler(nil);
    }
}

#pragma mark - VOICE GATE (상시 대기 — 사용자 목소리만 통과시키는 사이드카)

// 파이프 프레임: <u32 길이><페이로드>. 페이로드 첫 바이트 '{' JSON 명령, 'M' 마이크 PCM16 16k,
// 'S' 시스템 출력 PCM16 16k (루프백), 'V' 얼굴 텔레메트리 JSON.
- (void)gateWriteFrame:(NSData *)payload {
    NSFileHandle *fh = self.gateIn;
    if (fh == nil || payload.length == 0) return;
    dispatch_async(self.gateWriteQ, ^{
        uint32_t n = (uint32_t)payload.length;
        NSMutableData *d = [NSMutableData dataWithCapacity:payload.length + 4];
        [d appendBytes:&n length:4];
        [d appendData:payload];
        @try { [fh writeData:d]; } @catch (NSException *e) { (void)e; }
    });
}

- (void)gateWriteJSON:(NSString *)json {
    [self gateWriteFrame:[json dataUsingEncoding:NSUTF8StringEncoding]];
}

// float32 (임의 샘플레이트, 모노) → int16 16k 프레임 (선형 보간 다운샘플)
- (NSData *)gateResampleToPipe:(const float *)src count:(NSUInteger)n rate:(double)rate tag:(char)tag {
    NSUInteger m = (NSUInteger)(n * 16000.0 / rate);
    if (m == 0) return nil;
    NSMutableData *out = [NSMutableData dataWithLength:1 + m * 2];
    uint8_t *bytes = out.mutableBytes;
    bytes[0] = (uint8_t)tag;
    int16_t *dst = (int16_t *)(bytes + 1);
    double step = (double)n / (double)m;
    for (NSUInteger i = 0; i < m; i++) {
        double pos = i * step;
        NSUInteger k = (NSUInteger)pos;
        float a = src[k], b = src[MIN(k + 1, n - 1)];
        float v = a + (b - a) * (float)(pos - k);
        dst[i] = (int16_t)(MAX(-1.f, MIN(1.f, v)) * 32767.f);
    }
    return out;
}

// ---- 마이크: AVAudioEngine 입력 탭 → 16k 모노 → 'M' 프레임
- (BOOL)gateStartMic {
    AVAudioEngine *eng = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = eng.inputNode;
    AVAudioFormat *inFmt = [input outputFormatForBus:0];
    if (inFmt.sampleRate <= 0) return NO;
    __weak AppDelegate *weakSelf = self;
    [input installTapOnBus:0 bufferSize:2048 format:inFmt
                     block:^(AVAudioPCMBuffer *buf, AVAudioTime *when) {
        AppDelegate *s = weakSelf;
        if (s == nil || buf.frameLength == 0) return;
        // 채널 평균 → 모노 float
        NSUInteger n = buf.frameLength;
        float *mono = malloc(sizeof(float) * n);
        AVAudioChannelCount ch = buf.format.channelCount;
        for (NSUInteger i = 0; i < n; i++) {
            float acc = 0;
            for (AVAudioChannelCount c = 0; c < ch; c++) acc += buf.floatChannelData[c][i];
            mono[i] = acc / (float)ch;
        }
        NSData *frame = [s gateResampleToPipe:mono count:n rate:buf.format.sampleRate tag:'M'];
        free(mono);
        if (frame != nil) [s gateWriteFrame:frame];
    }];
    NSError *err = nil;
    if (![eng startAndReturnError:&err]) {
        NSLog(@"gate mic start failed: %@", err);
        return NO;
    }
    self.gateEngine = eng;
    return YES;
}

// ---- 시스템 출력 루프백: 전 프로세스 출력을 모노 탭으로 → 'S' 프레임
- (BOOL)gateStartSystemTap {
    if (@available(macOS 14.2, *)) {
        CATapDescription *desc = [[CATapDescription alloc] initMonoGlobalTapButExcludeProcesses:@[]];
        desc.name = @"OmniGateTap";
        desc.privateTap = YES;
        desc.muteBehavior = CATapUnmuted;
        AudioObjectID tapID = kAudioObjectUnknown;
        OSStatus st = AudioHardwareCreateProcessTap(desc, &tapID);
        if (st != noErr || tapID == kAudioObjectUnknown) {
            NSLog(@"gate tap create failed: %d", (int)st);
            return NO;
        }
        AudioStreamBasicDescription fmt = {0};
        UInt32 sz = sizeof(fmt);
        AudioObjectPropertyAddress addr = { kAudioTapPropertyFormat,
            kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
        AudioObjectGetPropertyData(tapID, &addr, 0, NULL, &sz, &fmt);
        double rate = fmt.mSampleRate > 0 ? fmt.mSampleRate : 48000.0;
        NSDictionary *agg = @{
            @kAudioAggregateDeviceNameKey : @"OmniGateAgg",
            @kAudioAggregateDeviceUIDKey : [NSUUID UUID].UUIDString,
            @kAudioAggregateDeviceIsPrivateKey : @YES,
            @kAudioAggregateDeviceTapAutoStartKey : @YES,
            @kAudioAggregateDeviceTapListKey : @[ @{
                @kAudioSubTapUIDKey : desc.UUID.UUIDString,
                @kAudioSubTapDriftCompensationKey : @YES } ],
        };
        AudioObjectID aggID = kAudioObjectUnknown;
        st = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)agg, &aggID);
        if (st != noErr || aggID == kAudioObjectUnknown) {
            NSLog(@"gate aggregate failed: %d", (int)st);
            AudioHardwareDestroyProcessTap(tapID);
            return NO;
        }
        __weak AppDelegate *weakSelf = self;
        AudioDeviceIOProcID procID = NULL;
        st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, NULL,
            ^(const AudioTimeStamp *inNow, const AudioBufferList *inInputData,
              const AudioTimeStamp *inInputTime, AudioBufferList *outOutputData,
              const AudioTimeStamp *inOutputTime) {
            AppDelegate *s = weakSelf;
            if (s == nil || inInputData == NULL || inInputData->mNumberBuffers == 0) return;
            const AudioBuffer *b = &inInputData->mBuffers[0];
            NSUInteger ch = MAX(1u, b->mNumberChannels);
            NSUInteger n = b->mDataByteSize / sizeof(float) / ch;
            if (n == 0) return;
            const float *src = (const float *)b->mData;
            float *mono = malloc(sizeof(float) * n);
            for (NSUInteger i = 0; i < n; i++) {
                float acc = 0;
                for (NSUInteger c = 0; c < ch; c++) acc += src[i * ch + c];
                mono[i] = acc / (float)ch;
            }
            NSData *frame = [s gateResampleToPipe:mono count:n rate:s.gateTapRate tag:'S'];
            free(mono);
            if (frame != nil) [s gateWriteFrame:frame];
        });
        if (st != noErr) {
            AudioHardwareDestroyAggregateDevice(aggID);
            AudioHardwareDestroyProcessTap(tapID);
            return NO;
        }
        self.gateTapID = tapID;
        self.gateAggID = aggID;
        self.gateIOProc = procID;
        self.gateTapRate = rate;
        st = AudioDeviceStart(aggID, procID);
        if (st != noErr) {
            NSLog(@"gate tap start failed: %d", (int)st);
            [self gateStopSystemTap];
            return NO;
        }
        return YES;
    }
    return NO;
}

- (void)gateStopSystemTap {
    if (self.gateAggID != kAudioObjectUnknown && self.gateAggID != 0) {
        if (self.gateIOProc != NULL) {
            AudioDeviceStop(self.gateAggID, self.gateIOProc);
            AudioDeviceDestroyIOProcID(self.gateAggID, self.gateIOProc);
        }
        AudioHardwareDestroyAggregateDevice(self.gateAggID);
    }
    if (self.gateTapID != kAudioObjectUnknown && self.gateTapID != 0) {
        if (@available(macOS 14.2, *)) AudioHardwareDestroyProcessTap(self.gateTapID);
    }
    self.gateAggID = 0; self.gateTapID = 0; self.gateIOProc = NULL;
}

- (void)gateStop {
    if (self.gateEngine != nil) {
        [self.gateEngine.inputNode removeTapOnBus:0];
        [self.gateEngine stop];
        self.gateEngine = nil;
    }
    [self gateStopSystemTap];
    if (self.gateTask != nil) {
        @try { [self.gateTask terminate]; } @catch (NSException *e) { (void)e; }
    }
    self.gateTask = nil;
    self.gateIn = nil;
}

- (void)gatePushToJS:(NSDictionary *)ev {
    NSData *safe = [NSJSONSerialization dataWithJSONObject:ev options:0 error:nil];
    NSString *json = safe ? [[NSString alloc] initWithData:safe encoding:NSUTF8StringEncoding] : nil;
    if (json == nil) return;
    NSString *js = [NSString stringWithFormat:@"window.OmniAI && OmniAI._gate(%@)", json];
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.webView evaluateJavaScript:js completionHandler:nil];
    });
}

// 사이드카 stdout 버퍼에서 완성된 줄을 꺼내 처리한다. 통과한 발화(pcm24)는
// JS를 거치지 않고 바로 리얼타임 WSS로 append+commit (대용량 base64 왕복 회피).
- (void)gateDrainLines {
    NSArray *lines = nil;
    @synchronized(self) {
        NSData *buf = self.gateBuf;
        if (buf == nil) return;
        NSString *str = [[NSString alloc] initWithData:buf encoding:NSUTF8StringEncoding];
        if (str == nil) return;
        NSRange last = [str rangeOfString:@"\n" options:NSBackwardsSearch];
        if (last.location == NSNotFound) return;
        NSString *complete = [str substringToIndex:last.location];
        NSString *rest = [str substringFromIndex:last.location + 1];
        self.gateBuf = [[rest dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
        lines = [complete componentsSeparatedByString:@"\n"];
    }
    for (NSString *ln in lines) {
        if (ln.length == 0) continue;
        NSData *d = [ln dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = d ? [NSJSONSerialization JSONObjectWithData:d options:0 error:nil] : nil;
        if (![parsed isKindOfClass:[NSDictionary class]]) continue;
        NSMutableDictionary *ev = [parsed mutableCopy];
        NSString *pcm = [ev[@"pcm24"] isKindOfClass:[NSString class]] ? ev[@"pcm24"] : nil;
        if (pcm != nil) {
            [ev removeObjectForKey:@"pcm24"];
            NSURLSessionWebSocketTask *task = self.aiRtTask;
            if (task != nil && [ev[@"user"] boolValue]) {
                NSDictionary *append = @{ @"type" : @"input_audio_buffer.append", @"audio" : pcm };
                NSData *aj = [NSJSONSerialization dataWithJSONObject:append options:0 error:nil];
                NSString *as = [[NSString alloc] initWithData:aj encoding:NSUTF8StringEncoding];
                [task sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:as]
                completionHandler:^(NSError *e) { (void)e; }];
                [task sendMessage:[[NSURLSessionWebSocketMessage alloc]
                    initWithString:@"{\"type\":\"input_audio_buffer.commit\"}"]
                completionHandler:^(NSError *e) { (void)e; }];
                ev[@"sent"] = @YES;
            } else {
                ev[@"sent"] = @NO;
            }
        }
        [self gatePushToJS:ev];
    }
}

- (void)handleGate:(NSString *)cmd a:(NSDictionary *)a arg:(NSString *)arg msgId:(NSString *)msgId {
    if ([cmd isEqualToString:@"ai.gateStart"]) {
        [self gateStop];
        NSString *py = [OmniBaseDir() stringByAppendingPathComponent:@"voice_engine/venv/bin/python"];
        NSString *script = [OmniBaseDir() stringByAppendingPathComponent:@"scripts/omni_gate.py"];
        if (![NSFileManager.defaultManager fileExistsAtPath:py]
            || ![NSFileManager.defaultManager fileExistsAtPath:script]) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NO_GATE_ENV" } forId:msgId];
            return;
        }
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:py];
        task.arguments = @[ script, @"pipe" ];
        task.currentDirectoryURL = [NSURL fileURLWithPath:OmniBaseDir()];
        NSPipe *outPipe = [NSPipe pipe], *inPipe = [NSPipe pipe], *errPipe = [NSPipe pipe];
        task.standardOutput = outPipe;
        task.standardInput = inPipe;
        task.standardError = errPipe;
        self.gateBuf = [NSMutableData data];
        __weak AppDelegate *weakSelf = self;
        outPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *fh) {
            NSData *d = fh.availableData;
            AppDelegate *s = weakSelf;
            if (s == nil || d.length == 0) return;
            @synchronized(s) { [s.gateBuf appendData:d]; }
            [s gateDrainLines];
        };
        errPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *fh) {
            (void)fh.availableData; // 토치 경고 등 — 버림
        };
        task.terminationHandler = ^(NSTask *t) {
            AppDelegate *s = weakSelf;
            if (s == nil || s.gateTask != t) return;
            s.gateTask = nil;
            [s gatePushToJS:@{ @"ev" : @"exit", @"status" : @(t.terminationStatus) }];
        };
        NSError *err = nil;
        if (![task launchAndReturnError:&err]) {
            [self deliverPayload:@{ @"ok" : @NO,
                @"error" : err.localizedDescription ?: @"launch" } forId:msgId];
            return;
        }
        self.gateTask = task;
        self.gateIn = inPipe.fileHandleForWriting;
        if (self.gateWriteQ == nil) {
            self.gateWriteQ = dispatch_queue_create("omni.gate.write", DISPATCH_QUEUE_SERIAL);
        }
        BOOL mic = [self gateStartMic];
        BOOL tap = [self gateStartSystemTap];   // 실패해도 계속 (루프백 신호만 없어짐)
        self.gateTapOK = tap;
        [self deliverPayload:@{ @"ok" : @(mic), @"mic" : @(mic), @"loopback" : @(tap),
                                @"error" : mic ? @"" : @"MIC_FAILED" } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.gateCmd"]) {
        if (self.gateIn == nil || arg == nil) {
            [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
            return;
        }
        [self gateWriteJSON:arg];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.gateStop"]) {
        [self gateStop];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.gateStatus"]) {
        NSString *profile = [NSHomeDirectory() stringByAppendingPathComponent:@".omni/voice_profile.json"];
        NSString *store = [NSHomeDirectory() stringByAppendingPathComponent:@".omni/voice/profiles.json"];
        BOOL has = [NSFileManager.defaultManager fileExistsAtPath:profile]
                || [NSFileManager.defaultManager fileExistsAtPath:store];
        [self deliverPayload:@{ @"ok" : @YES,
                                @"running" : @(self.gateTask != nil && self.gateTask.isRunning),
                                @"loopback" : @(self.gateTapOK),
                                @"profile" : @(has) }
                       forId:msgId];

    } else if ([cmd isEqualToString:@"ai.gateNote"]) {
        // 게이트 판정 로그 (~/.omni/gate.log) — 진단·검증용
        NSString *text = [a[@"text"] isKindOfClass:[NSString class]] ? a[@"text"] : @"";
        NSString *path = [NSHomeDirectory() stringByAppendingPathComponent:@".omni/gate.log"];
        NSDateFormatter *df = [[NSDateFormatter alloc] init];
        df.dateFormat = @"HH:mm:ss";
        NSString *line = [NSString stringWithFormat:@"[%@] %@\n", [df stringFromDate:NSDate.date], text];
        NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:path];
        if (fh == nil) {
            [line writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
        } else {
            [fh seekToEndOfFile];
            [fh writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
            [fh closeFile];
        }
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
    }
}

#pragma mark - CALENDAR (EventKit — 맥 캘린더 직접 읽기/쓰기)

// 맥 캘린더 앱에 들어온 모든 캘린더(iCloud·구글 등 인터넷 계정 구독 포함)를
// EventKit으로 읽고 쓴다. 학교 구글 계정처럼 개발자 API를 못 쓰는 계정도
// 시스템 설정 > 인터넷 계정에 추가만 하면 여기 잡힌다. 권한: 캘린더 전체 접근.
- (void)handleCal:(NSString *)cmd arg:(NSString *)arg msgId:(NSString *)msgId {
    NSDictionary *a = @{};
    if (arg != nil) {
        NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
        if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
    }
    if (self.eventStore == nil) self.eventStore = [[EKEventStore alloc] init];
    EKEventStore *store = self.eventStore;

    NSString *(^hexColor)(EKCalendar *) = ^NSString *(EKCalendar *c) {
        // macOS EventKit: EKCalendar.color 는 NSColor*
        NSColor *nc = [c.color colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
        if (nc == nil) return @"#35d6ff";
        return [NSString stringWithFormat:@"#%02X%02X%02X",
                (int)(nc.redComponent * 255), (int)(nc.greenComponent * 255),
                (int)(nc.blueComponent * 255)];
    };

    void (^run)(BOOL) = ^(BOOL granted) {
        if (!granted) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"CAL_DENIED" } forId:msgId];
            return;
        }
        if ([cmd isEqualToString:@"cal.events"]) {
            double days = [a[@"days"] isKindOfClass:[NSNumber class]] ? [a[@"days"] doubleValue] : 7;
            NSDate *start = [NSCalendar.currentCalendar startOfDayForDate:NSDate.date];
            NSDate *end = [start dateByAddingTimeInterval:days * 86400.0];
            NSPredicate *pred = [store predicateForEventsWithStartDate:start endDate:end calendars:nil];
            NSArray<EKEvent *> *events = [[store eventsMatchingPredicate:pred]
                sortedArrayUsingSelector:@selector(compareStartDateWithEvent:)];
            NSMutableArray *out = [NSMutableArray array];
            for (EKEvent *e in events) {
                NSString *notes = e.notes ?: @"";
                if (notes.length > 200) notes = [notes substringToIndex:200];
                [out addObject:@{ @"id" : e.eventIdentifier ?: @"",
                                  @"title" : e.title ?: @"(제목 없음)",
                                  @"start" : @(e.startDate.timeIntervalSince1970),
                                  @"end" : @(e.endDate.timeIntervalSince1970),
                                  @"allDay" : @(e.isAllDay),
                                  @"calendar" : e.calendar.title ?: @"",
                                  @"color" : hexColor(e.calendar),
                                  @"location" : e.location ?: @"",
                                  @"notes" : notes }];
                if (out.count >= 300) break;
            }
            [self deliverPayload:@{ @"ok" : @YES, @"items" : out } forId:msgId];

        } else if ([cmd isEqualToString:@"cal.calendars"]) {
            NSMutableArray *out = [NSMutableArray array];
            for (EKCalendar *c in [store calendarsForEntityType:EKEntityTypeEvent]) {
                [out addObject:@{ @"title" : c.title ?: @"", @"source" : c.source.title ?: @"",
                                  @"color" : hexColor(c), @"writable" : @(c.allowsContentModifications) }];
            }
            [self deliverPayload:@{ @"ok" : @YES, @"items" : out } forId:msgId];

        } else if ([cmd isEqualToString:@"cal.add"]) {
            NSString *title = [a[@"title"] isKindOfClass:[NSString class]] ? a[@"title"] : @"";
            if (title.length == 0 || ![a[@"start"] isKindOfClass:[NSNumber class]]) {
                [self deliverPayload:@{ @"ok" : @NO, @"error" : @"BAD_ARGS" } forId:msgId];
                return;
            }
            EKEvent *ev = [EKEvent eventWithEventStore:store];
            ev.title = title;
            ev.startDate = [NSDate dateWithTimeIntervalSince1970:[a[@"start"] doubleValue]];
            ev.endDate = [a[@"end"] isKindOfClass:[NSNumber class]]
                ? [NSDate dateWithTimeIntervalSince1970:[a[@"end"] doubleValue]]
                : [ev.startDate dateByAddingTimeInterval:3600];
            ev.allDay = [a[@"allDay"] boolValue];
            if ([a[@"location"] isKindOfClass:[NSString class]]) ev.location = a[@"location"];
            if ([a[@"notes"] isKindOfClass:[NSString class]]) ev.notes = a[@"notes"];
            // 대상 캘린더: 명시 이름 > "OMNI" 전용 캘린더(없으면 iCloud/로컬에 생성)
            // > 구글이 아닌 쓰기 가능 캘린더 > 기본 캘린더. 학교 구글 계정처럼
            // 관리자 제한이 있는 계정에 쓰면 동기화 오류가 나므로 구글은 마지막 후보.
            NSArray<EKCalendar *> *cals = [store calendarsForEntityType:EKEntityTypeEvent];
            BOOL (^isGoogle)(EKCalendar *) = ^BOOL(EKCalendar *c) {
                NSString *src = c.source.title.lowercaseString ?: @"";
                return [src containsString:@"google"] || [src containsString:@"gmail"];
            };
            EKCalendar *target = nil;
            if ([a[@"calendar"] isKindOfClass:[NSString class]] && [a[@"calendar"] length] > 0) {
                for (EKCalendar *c in cals) {
                    if (c.allowsContentModifications
                        && [c.title caseInsensitiveCompare:a[@"calendar"]] == NSOrderedSame) { target = c; break; }
                }
            }
            if (target == nil) {
                for (EKCalendar *c in cals) {
                    if (c.allowsContentModifications
                        && [c.title caseInsensitiveCompare:@"OMNI"] == NSOrderedSame) { target = c; break; }
                }
            }
            if (target == nil) {
                // OMNI 캘린더 생성 — iCloud 우선, 없으면 로컬
                EKSource *home = nil;
                for (EKSource *src in store.sources) {
                    if (src.sourceType == EKSourceTypeCalDAV
                        && [src.title.lowercaseString containsString:@"icloud"]) { home = src; break; }
                }
                if (home == nil) {
                    for (EKSource *src in store.sources) {
                        if (src.sourceType == EKSourceTypeLocal) { home = src; break; }
                    }
                }
                if (home != nil) {
                    EKCalendar *nc = [EKCalendar calendarForEntityType:EKEntityTypeEvent eventStore:store];
                    nc.title = @"OMNI";
                    nc.source = home;
                    nc.CGColor = [NSColor colorWithSRGBRed:0.21 green:0.84 blue:1.0 alpha:1].CGColor;
                    NSError *cerr = nil;
                    if ([store saveCalendar:nc commit:YES error:&cerr]) target = nc;
                }
            }
            if (target == nil) {
                for (EKCalendar *c in cals) {
                    if (c.allowsContentModifications && !isGoogle(c)) { target = c; break; }
                }
            }
            if (target == nil && store.defaultCalendarForNewEvents.allowsContentModifications) {
                target = store.defaultCalendarForNewEvents;
            }
            if (target == nil) {
                for (EKCalendar *c in cals) {
                    if (c.allowsContentModifications) { target = c; break; }
                }
            }
            if (target == nil) {
                [self deliverPayload:@{ @"ok" : @NO, @"error" : @"쓰기 가능한 캘린더가 없습니다" } forId:msgId];
                return;
            }
            ev.calendar = target;
            NSError *err = nil;
            BOOL ok = [store saveEvent:ev span:EKSpanThisEvent commit:YES error:&err];
            [self deliverPayload:@{ @"ok" : @(ok), @"id" : ev.eventIdentifier ?: @"",
                                    @"calendar" : target.title ?: @"",
                                    @"error" : err.localizedDescription ?: @"" } forId:msgId];

        } else if ([cmd isEqualToString:@"cal.remove"]) {
            NSString *eid = [a[@"id"] isKindOfClass:[NSString class]] ? a[@"id"] : @"";
            EKEvent *ev = eid.length ? [store eventWithIdentifier:eid] : nil;
            if (ev == nil) {
                [self deliverPayload:@{ @"ok" : @NO, @"error" : @"NOT_FOUND" } forId:msgId];
                return;
            }
            NSError *err = nil;
            BOOL ok = [store removeEvent:ev span:EKSpanThisEvent commit:YES error:&err];
            [self deliverPayload:@{ @"ok" : @(ok), @"error" : err.localizedDescription ?: @"" } forId:msgId];
        } else {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"UNKNOWN_CMD" } forId:msgId];
        }
    };

    if (@available(macOS 14.0, *)) {
        [store requestFullAccessToEventsWithCompletion:^(BOOL granted, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{ run(granted); });
        }];
    } else {
        [store requestAccessToEntityType:EKEntityTypeEvent completion:^(BOOL granted, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{ run(granted); });
        }];
    }
}


- (void)handleAI:(NSString *)cmd arg:(NSString *)arg msgId:(NSNumber *)msgId {
    NSDictionary *a = nil;
    if (arg != nil) {
        NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
        if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
    }

    if ([cmd hasPrefix:@"ai.gate"]) {
        [self handleGate:cmd a:a arg:arg msgId:msgId];
        return;
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

    } else if ([cmd isEqualToString:@"ai.haloPoll"]) {
        // Halo 안경 브리지 메일박스 소비 — 브리지가 append, 앱이 폴링해
        // 통째로 읽고 삭제한다 (전사 표시 + 액션 실행용)
        NSString *box = [NSHomeDirectory()
            stringByAppendingPathComponent:@".omni/halo_mailbox.jsonl"];
        NSString *content = [NSString stringWithContentsOfFile:box
            encoding:NSUTF8StringEncoding error:NULL];
        NSMutableArray *lines = [NSMutableArray array];
        if (content.length > 0) {
            [NSFileManager.defaultManager removeItemAtPath:box error:nil];
            for (NSString *ln in [content componentsSeparatedByString:@"\n"]) {
                if (ln.length > 0) [lines addObject:ln];
            }
        }
        [self deliverPayload:@{ @"ok" : @YES, @"lines" : lines } forId:msgId];

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
        if ([provider isEqualToString:@"gmail"]) {
            // 다중 계정: 한 줄 = "이메일 앱비밀번호" — 기존 파일에 추가,
            // 같은 이메일이 이미 있으면 그 줄을 새 값으로 교체
            NSString *newEmail = [[key componentsSeparatedByString:@" "] firstObject] ?: @"";
            NSString *existing = [NSString stringWithContentsOfFile:keyPath
                encoding:NSUTF8StringEncoding error:nil] ?: @"";
            NSMutableArray *lines = [NSMutableArray array];
            for (NSString *line in [existing componentsSeparatedByString:@"\n"]) {
                NSString *t = [line stringByTrimmingCharactersInSet:
                    NSCharacterSet.whitespaceAndNewlineCharacterSet];
                if (t.length == 0) continue;
                NSString *em = [[t componentsSeparatedByString:@" "] firstObject] ?: @"";
                if ([em isEqualToString:newEmail]) continue; // 교체 대상
                [lines addObject:t];
            }
            [lines addObject:key];
            key = [lines componentsJoinedByString:@"\n"];
        }
        NSError *err = nil;
        BOOL ok = [key writeToFile:keyPath atomically:YES
                          encoding:NSUTF8StringEncoding error:&err];
        if (ok) {
            [NSFileManager.defaultManager setAttributes:@{ NSFilePosixPermissions : @0600 }
                                           ofItemAtPath:keyPath error:nil];
        }
        [self deliverPayload:@{ @"ok" : @(ok),
                                @"error" : err.localizedDescription ?: @"" } forId:msgId];

    } else if ([cmd isEqualToString:@"ai.clearKey"]) {
        NSString *provider = [a[@"provider"] isKindOfClass:[NSString class]] ? a[@"provider"] : @"";
        if ([provider isEqualToString:@"gmail"]) {
            NSString *p = [NSHomeDirectory() stringByAppendingPathComponent:@".omni/gmail.key"];
            [NSFileManager.defaultManager removeItemAtPath:p error:nil];
            [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
        } else {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"unsupported" } forId:msgId];
        }

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
            ? a[@"model"] : @"gpt-realtime-2.1";
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

    } else if ([cmd isEqualToString:@"omnia.status"]) {
        // 로컬 LLM(Ollama) 준비 상태 — 미기동이면 JS가 안내
        NSURL *url = [NSURL URLWithString:@"http://127.0.0.1:11434/api/tags"];
        NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
        req.timeoutInterval = 3;
        [[NSURLSession.sharedSession dataTaskWithRequest:req
            completionHandler:^(NSData *data, NSURLResponse *resp, NSError *error) {
            id parsed = data ? [NSJSONSerialization JSONObjectWithData:data
                                                               options:0 error:nil] : nil;
            NSMutableArray *names = [NSMutableArray array];
            if ([parsed isKindOfClass:[NSDictionary class]]) {
                for (NSDictionary *m in parsed[@"models"]) {
                    if ([m[@"name"] isKindOfClass:[NSString class]]) [names addObject:m[@"name"]];
                }
            }
            [self deliverPayload:@{ @"ok" : @(error == nil && names.count > 0),
                                    @"models" : names,
                                    @"error" : error.localizedDescription ?: @"",
                                    @"status" : @([(NSHTTPURLResponse *)resp statusCode]) }
                           forId:msgId];
        }] resume];

    } else if ([cmd isEqualToString:@"omnia.chat"]) {
        // 로컬 LLM 대화 — 토큰을 OmniaAI._tok 으로 스트리밍 (키 없음, 완전 로컬)
        NSString *model = [a[@"model"] isKindOfClass:[NSString class]]
            ? a[@"model"] : @"qwen3.6-aggressive-local:latest";
        NSArray *messages = [a[@"messages"] isKindOfClass:[NSArray class]] ? a[@"messages"] : @[];
        NSNumber *turn = [a[@"turn"] isKindOfClass:[NSNumber class]] ? a[@"turn"] : @0;
        NSDictionary *body = @{ @"model" : model, @"messages" : messages,
                                @"stream" : @YES };
        NSData *bodyData = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
        NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:
            [NSURL URLWithString:@"http://127.0.0.1:11434/api/chat"]];
        req.HTTPMethod = @"POST";
        req.HTTPBody = bodyData;
        req.timeoutInterval = 600;
        [req setValue:@"application/json" forHTTPHeaderField:@"content-type"];
        __weak AppDelegate *weakSelf = self;
        // NSURLSession 스트리밍: 델리게이트 없이 dataTask로 받되 줄 단위 JSON을 파싱해
        // 중간 토큰을 즉시 밀어 넣기 위해 별도 큐에서 청크를 읽는다
        if (self.omniaSession == nil) {
            NSURLSessionConfiguration *cfg =
                [NSURLSessionConfiguration defaultSessionConfiguration];
            self.omniaSession = [NSURLSession sessionWithConfiguration:cfg
                delegate:self delegateQueue:nil];
        }
        self.omniaBuf = [NSMutableString string];
        NSURLSessionDataTask *task = [self.omniaSession dataTaskWithRequest:req];
        self.omniaTurn = turn;
        [task resume];
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
        (void)weakSelf;

    } else if ([cmd isEqualToString:@"omnia.stop"]) {
        [self.omniaSession invalidateAndCancel];
        self.omniaSession = nil;
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];

    } else if ([cmd isEqualToString:@"omnia.run"]) {
        // 오미니아 터미널 실행 — JS가 사용자 승인을 받은 뒤에만 호출한다
        NSString *script = [a[@"script"] isKindOfClass:[NSString class]] ? a[@"script"] : nil;
        if (script.length == 0) {
            [self deliverPayload:@{ @"ok" : @NO, @"error" : @"empty" } forId:msgId];
            return;
        }
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            NSTask *task = [[NSTask alloc] init];
            task.executableURL = [NSURL fileURLWithPath:@"/bin/zsh"];
            task.arguments = @[ @"-lc", script ];
            task.currentDirectoryURL = [NSURL fileURLWithPath:NSHomeDirectory()];
            NSPipe *outPipe = [NSPipe pipe];
            task.standardOutput = outPipe;
            task.standardError = outPipe;
            NSError *err = nil;
            if (![task launchAndReturnError:&err]) {
                [self deliverPayload:@{ @"ok" : @NO,
                    @"error" : err.localizedDescription ?: @"launch failed" } forId:msgId];
                return;
            }
            // 60초 안전 타임아웃
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC),
                           dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                if (task.isRunning) [task terminate];
            });
            NSData *outData = [outPipe.fileHandleForReading readDataToEndOfFile];
            [task waitUntilExit];
            NSString *out = [[NSString alloc] initWithData:outData
                encoding:NSUTF8StringEncoding] ?: @"";
            if (out.length > 20000) out = [out substringToIndex:20000];
            [self deliverPayload:@{ @"ok" : @YES, @"output" : out,
                                    @"code" : @(task.terminationStatus) } forId:msgId];
        });

    } else if ([cmd isEqualToString:@"omnia.save"]) {
        // 오미니아가 만든 코드/스크립트를 파일로 저장 (다운로드 대체 — 저장 위치 선택)
        NSString *name = [a[@"name"] isKindOfClass:[NSString class]] ? a[@"name"] : @"omnia.txt";
        NSString *content = [a[@"content"] isKindOfClass:[NSString class]] ? a[@"content"] : @"";
        NSSavePanel *panel = [NSSavePanel savePanel];
        panel.nameFieldStringValue = name.lastPathComponent;
        [panel beginWithCompletionHandler:^(NSModalResponse result) {
            if (result != NSModalResponseOK || panel.URL == nil) {
                [self deliverPayload:@{ @"ok" : @NO, @"error" : @"cancelled" } forId:msgId];
                return;
            }
            NSError *werr = nil;
            BOOL ok = [content writeToURL:panel.URL atomically:YES
                                 encoding:NSUTF8StringEncoding error:&werr];
            [self deliverPayload:@{ @"ok" : @(ok), @"path" : panel.URL.path ?: @"" }
                           forId:msgId];
        }];

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

    } else if ([cmd isEqualToString:@"ai.calc"]) {
        // 정확 계산기 — scripts/omni_calc.py (ast 화이트리스트 안전 평가기).
        // LLM은 수식만 만들고 계산은 여기서 한다 (음성 모델의 암산 오류 방지)
        NSString *expr = [a[@"expr"] isKindOfClass:[NSString class]] ? a[@"expr"] : @"";
        NSString *helper = [OmniBaseDir()
            stringByAppendingPathComponent:@"scripts/omni_calc.py"];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            NSTask *task = [[NSTask alloc] init];
            task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/python3"];
            task.arguments = @[ helper, expr ];
            NSPipe *outPipe = [NSPipe pipe];
            task.standardOutput = outPipe;
            task.standardError = [NSPipe pipe];
            NSError *err = nil;
            if (![task launchAndReturnError:&err]) {
                [self deliverPayload:@{ @"ok" : @NO,
                    @"error" : err.localizedDescription ?: @"calc launch" } forId:msgId];
                return;
            }
            // 5초 타임아웃 — 폭주 방지 (평가기 자체도 상한이 있음)
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC),
                           dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                if (task.isRunning) [task terminate];
            });
            NSData *outData = [outPipe.fileHandleForReading readDataToEndOfFile];
            [task waitUntilExit];
            id parsed = outData.length
                ? [NSJSONSerialization JSONObjectWithData:outData options:0 error:nil] : nil;
            [self deliverPayload:([parsed isKindOfClass:[NSDictionary class]] ? parsed
                : @{ @"ok" : @NO, @"error" : @"계산 시간 초과 또는 출력 오류" }) forId:msgId];
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
