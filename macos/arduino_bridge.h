#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

// Arduino IDE panel backend: wraps the arduino-cli bundled with Arduino IDE.app
// (fallback: homebrew) and a POSIX serial port session.
//
// All output is streamed into the page via evaluateJavaScript:
//   window.OmniArduino._out(line, isErr)   — cli job output, line by line
//   window.OmniArduino._done(exitCode)     — cli job finished
//   window.OmniArduino._serial(b64chunk)   — serial data (base64, raw bytes)
//   window.OmniArduino._serialClosed()     — serial port went away
@interface ArduinoBridge : NSObject

- (instancetype)initWithWebView:(WKWebView *)webView;

// Path of the arduino-cli binary, or nil if none found.
+ (NSString *)cliPath;

// One job at a time. args are passed to arduino-cli verbatim (no shell).
// Streaming — for human-readable output (compile/upload/lib install).
- (BOOL)runJob:(NSArray<NSString *> *)args;
- (void)cancelJob;

// Structured queries. arduino-cli --json output can be enormous
// (board listall is ~6 MB / 190k lines), so these parse natively and hand back
// only the few fields the UI needs — never streamed line by line.
- (NSArray<NSDictionary *> *)listPorts;
- (NSArray<NSDictionary *> *)listBoards;
- (NSArray<NSDictionary *> *)listInstalledLibs;
- (NSArray<NSDictionary *> *)searchLibs:(NSString *)query;

// Sketchbook (~/Documents/Arduino) folders that contain a .ino.
- (NSArray<NSDictionary *> *)sketches;

// Serial monitor session (single).
- (NSDictionary *)serialOpen:(NSString *)port baud:(int)baud;
- (void)serialClose;
- (BOOL)serialSend:(NSString *)text;

@end
