#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "sp1_status.h"

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
            @"js" : @"application/javascript", @"json" : @"application/json",
            @"bin" : @"application/octet-stream", @"wasm" : @"application/wasm",
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

@interface AppDelegate : NSObject <NSApplicationDelegate, WKScriptMessageHandler>
@property (strong) NSWindow *window;
@property (strong) WKWebView *webView;
@property (strong) OmniSchemeHandler *schemeHandler;
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
    [config.userContentController addScriptMessageHandler:self name:@"omni"];
    self.schemeHandler = [OmniSchemeHandler new];
    [config setURLSchemeHandler:self.schemeHandler forURLScheme:@"omni"];

    WKWebView *webView = [[WKWebView alloc] initWithFrame:window.contentView.bounds
                                            configuration:config];
    webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
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
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
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
