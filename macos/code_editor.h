#import <Foundation/Foundation.h>

// CODE EDITOR 패널의 네이티브 반쪽.
// 파일: 디렉토리 나열 / 텍스트 읽기·쓰기 (루트 검증은 호출자 책임).
// 터미널: forkpty(zsh) 세션 매니저 — 출력은 emit 콜백으로 JS에 푸시.

NSDictionary *CETree(NSString *path);
NSDictionary *CERead(NSString *path);
BOOL CEWrite(NSString *path, NSString *text);

@interface OmniTermManager : NSObject
- (instancetype)initWithEmit:(void (^)(NSString *js))emit;
- (NSDictionary *)openWithCwd:(NSString *)cwd cols:(int)cols rows:(int)rows;
- (BOOL)writeTid:(NSInteger)tid data:(NSData *)data;
- (BOOL)resizeTid:(NSInteger)tid cols:(int)cols rows:(int)rows;
- (void)closeTid:(NSInteger)tid;
- (void)closeAll;
@end
