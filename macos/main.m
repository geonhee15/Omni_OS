#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <signal.h>
#import "sp1_status.h"
#import "arduino_bridge.h"

// SP-1 watcher pause/resume lives in sp1_status.m (SP1PauseWatcher /
// SP1ResumeWatcher). Resume is also called unconditionally on app exit so
// the security watcher is never left stopped.

// Serves bundle Resources/web/* over omni://local/... — unlike bare file://,
// a custom scheme gives the page a real origin, so fetch()/XHR work and the
// Human/TensorFlow.js model loader can pull its model files.
@interface OmniSchemeHandler : NSObject <WKURLSchemeHandler>
@end

@implementation OmniSchemeHandler

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    NSString *path = url.path.length ? url.path : @"/index.html";
    if ([path isEqualToString:@"/"]) path = @"/index.html";

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

@interface AppDelegate : NSObject <NSApplicationDelegate, WKScriptMessageHandler, WKUIDelegate>
@property (strong) NSWindow *window;
@property (strong) WKWebView *webView;
@property (strong) OmniSchemeHandler *schemeHandler;
@property (strong) NSURLSessionWebSocketTask *arcTask;
@property (strong) ArduinoBridge *arduino;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
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
    SP1ResumeWatcher();
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

    if ([cmd isEqualToString:@"sp1.status"]) {
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
        // save the current point cloud via NSSavePanel
        NSDictionary *a = nil;
        if (arg != nil) {
            NSData *jd = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) a = parsed;
        }
        NSString *b64 = [a[@"data"] isKindOfClass:[NSString class]] ? a[@"data"] : nil;
        NSString *fname = [a[@"name"] isKindOfClass:[NSString class]] ? a[@"name"] : @"arc_scan.ply";
        NSData *data = b64 ? [[NSData alloc] initWithBase64EncodedString:b64 options:0] : nil;
        if (data == nil) {
            [self deliverPayload:@{ @"ok" : @NO } forId:msgId];
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                NSSavePanel *panel = [NSSavePanel savePanel];
                panel.nameFieldStringValue = fname;
                [panel beginSheetModalForWindow:self.window
                              completionHandler:^(NSModalResponse result) {
                    BOOL ok = NO;
                    if (result == NSModalResponseOK && panel.URL != nil) {
                        ok = [data writeToURL:panel.URL atomically:YES];
                    }
                    [self deliverPayload:@{ @"ok" : @(ok) } forId:msgId];
                }];
            });
        }
    } else if ([cmd isEqualToString:@"arc.disconnect"]) {
        [self.arcTask cancel];
        self.arcTask = nil;
        [self deliverPayload:@{ @"ok" : @YES } forId:msgId];
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
