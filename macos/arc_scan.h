#import <Foundation/Foundation.h>

// Scans the local /24 subnet for ARC-Scan devices (ESP32 WebSocket on port 81).
// Two phases: a fast concurrent TCP connect scan to find open :81 hosts, then a
// WebSocket handshake on each candidate to confirm it streams arc-scan JSON
// ({"a":…,"d":[…]}). Blocking (a few seconds) — call off the main thread.
// Returns [{ip: "192.168.0.x", verified: bool}], verified-first.
NSArray<NSDictionary *> *ARCScanDevices(void);
