#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property (strong) NSWindow *window;
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
    // 웹 화면의 --bg-deep(#020813)와 동일한 색으로 타이틀바를 자연스럽게 잇는다
    window.backgroundColor = [NSColor colorWithSRGBRed:0x02 / 255.0
                                                 green:0x08 / 255.0
                                                  blue:0x13 / 255.0
                                                 alpha:1.0];
    window.minSize = NSMakeSize(640, 480);
    [window center];

    WKWebView *webView = [[WKWebView alloc] initWithFrame:window.contentView.bounds
                                            configuration:[WKWebViewConfiguration new]];
    webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [webView setValue:@NO forKey:@"drawsBackground"];

    NSURL *url = [[NSBundle mainBundle] URLForResource:@"index"
                                         withExtension:@"html"
                                          subdirectory:@"web"];
    if (url == nil) {
        NSLog(@"web/index.html not found in app bundle");
        [NSApp terminate:nil];
        return;
    }
    [webView loadFileURL:url allowingReadAccessToURL:url.URLByDeletingLastPathComponent];

    [window.contentView addSubview:webView];
    [window makeKeyAndOrderFront:nil];
    self.window = window;
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];

        // Cmd+Q, Cmd+W, Cmd+M이 동작하도록 최소한의 메뉴 구성
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
