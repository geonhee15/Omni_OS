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
- (BOOL)runJob:(NSArray<NSString *> *)args;
- (void)cancelJob;

// Sketchbook (~/Documents/Arduino) folders that contain a .ino.
- (NSArray<NSDictionary *> *)sketches;

// Serial monitor session (single).
- (NSDictionary *)serialOpen:(NSString *)port baud:(int)baud;
- (void)serialClose;
- (BOOL)serialSend:(NSString *)text;

@end
