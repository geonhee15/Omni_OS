// OMNI_AI 네이티브 지원 — 한국어 음성 인식(SFSpeechRecognizer) 리스너.
// 이벤트는 onEvent 블록으로 메인 큐에 전달된다:
//   {type:"partial"|"final", text}   인식 텍스트 (final이면 세션 종료)
//   {type:"level", rms}              마이크 입력 레벨 (비주얼라이저용)
//   {type:"state", state, detail?}   listening | error | unavailable
#import <Foundation/Foundation.h>

@interface OmniAIListener : NSObject
@property (nonatomic, copy) void (^onEvent)(NSDictionary *event);
@property (nonatomic, copy) NSString *localeId; // 기본 ko-KR, start 전에 설정
@property (readonly) BOOL running;

// 음성 인식 + 마이크 권한을 순서대로 요청. done(granted, reason)
- (void)requestAuthThen:(void (^)(BOOL granted, NSString *reason))done;
- (void)start;   // 인식 세션 시작 (권한은 이미 있어야 함)
- (void)stop;    // 오디오 입력 종료 — 최종 결과(final)가 곧 이벤트로 온다
- (void)cancel;  // 즉시 중단, final 없음
@end
