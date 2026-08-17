#import "omni_ai.h"
#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>

@interface OmniAIListener ()
@property (strong) SFSpeechRecognizer *rec;
@property (strong) AVAudioEngine *engine;
@property (strong) SFSpeechAudioBufferRecognitionRequest *req;
@property (strong) SFSpeechRecognitionTask *task;
@property (assign) BOOL active;      // 마이크 탭이 살아 있는 동안 YES
@property (assign) BOOL cancelled;   // teardown 이후 늦게 오는 콜백은 무시
@property (assign) NSUInteger levelCount; // 레벨 이벤트 스로틀용
@property (assign) int restarts;     // 세션 내 인식 태스크 재시작 횟수
@property (assign) BOOL allowServer; // 온디바이스 실패 후 서버 인식 허용
@property (copy) NSString *recLocale; // 현재 rec가 만들어진 로케일
@end

@implementation OmniAIListener

- (instancetype)init {
    if ((self = [super init])) {
        _localeId = @"ko-KR";
    }
    return self;
}

- (BOOL)running { return self.active; }

- (void)emit:(NSDictionary *)event {
    void (^cb)(NSDictionary *) = self.onEvent;
    if (cb == nil) return;
    dispatch_async(dispatch_get_main_queue(), ^{ cb(event); });
}

- (void)requestAuthThen:(void (^)(BOOL, NSString *))done {
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus st) {
        if (st != SFSpeechRecognizerAuthorizationStatusAuthorized) {
            done(NO, @"SPEECH_DENIED");
            return;
        }
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                                 completionHandler:^(BOOL granted) {
            done(granted, granted ? @"OK" : @"MIC_DENIED");
        }];
    }];
}

// 인식 요청+태스크 생성 (마이크 탭은 그대로 재사용).
// Apple 인식기는 침묵 몇 초/온디바이스 모델 부재 시 에러로 세션을 끝내버리는데,
// 사용자가 아직 말을 안 했을 뿐일 수 있으므로 에러 시 여기로 조용히 재진입한다.
- (void)beginTask {
    self.req = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    self.req.shouldReportPartialResults = YES;
    if (!self.allowServer && self.rec.supportsOnDeviceRecognition) {
        self.req.requiresOnDeviceRecognition = YES;
    }
    __weak typeof(self) weakSelf = self;
    self.task = [self.rec recognitionTaskWithRequest:self.req
        resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        typeof(self) s = weakSelf;
        if (s == nil || s.cancelled) return;
        if (result != nil) {
            NSString *text = result.bestTranscription.formattedString ?: @"";
            [s emit:@{ @"type" : result.isFinal ? @"final" : @"partial",
                       @"text" : text }];
            if (result.isFinal) [s teardown];
            return;
        }
        if (error != nil) {
            if (s.active && s.restarts < 12) {
                // 청취 중 에러(무음 타임아웃 1110, 온디바이스 불가 등) —
                // 사용자가 아직 말하기 전일 수 있으니 세션을 끊지 않고 재시작
                s.restarts++;
                s.allowServer = YES;
                [s.task cancel];
                s.task = nil;
                s.req = nil;
                [s beginTask];
                return;
            }
            // stop() 후의 에러 = 인식할 발화 없음 → 빈 final로 JS 대기 해제
            [s emit:@{ @"type" : @"final", @"text" : @"" }];
            [s teardown];
        }
    }];
}

- (void)start {
    if (self.active) return;
    NSString *loc = self.localeId.length ? self.localeId : @"ko-KR";
    if (self.rec == nil || ![loc isEqualToString:self.recLocale]) {
        self.rec = [[SFSpeechRecognizer alloc] initWithLocale:
            [NSLocale localeWithLocaleIdentifier:loc]];
        self.recLocale = loc;
    }
    if (self.rec == nil || !self.rec.isAvailable) {
        [self emit:@{ @"type" : @"state", @"state" : @"unavailable" }];
        return;
    }
    self.cancelled = NO;
    self.restarts = 0;
    self.allowServer = NO;
    // 엔진은 매 세션 새로 만든다 — 권한 승인 전에 잡은 입력 포맷이
    // 0Hz로 남는 문제를 피하기 위함
    self.engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = self.engine.inputNode;
    AVAudioFormat *fmt = [input outputFormatForBus:0];
    if (fmt.sampleRate <= 0) {
        [self emit:@{ @"type" : @"state", @"state" : @"error",
                      @"detail" : @"no input device" }];
        return;
    }
    __weak typeof(self) weakSelf = self;
    [input installTapOnBus:0 bufferSize:1024 format:fmt
                     block:^(AVAudioPCMBuffer *buf, AVAudioTime *when) {
        typeof(self) s = weakSelf;
        if (s == nil || !s.active) return;
        [s.req appendAudioPCMBuffer:buf]; // req 교체 직후 nil이어도 no-op라 안전
        float *ch = buf.floatChannelData ? buf.floatChannelData[0] : NULL;
        if (ch != NULL && buf.frameLength > 0 && (s.levelCount++ % 3) == 0) {
            float acc = 0;
            for (AVAudioFrameCount i = 0; i < buf.frameLength; i++) acc += ch[i] * ch[i];
            [s emit:@{ @"type" : @"level",
                       @"rms" : @(sqrtf(acc / buf.frameLength)) }];
        }
    }];

    [self beginTask];

    NSError *err = nil;
    [self.engine prepare];
    if (![self.engine startAndReturnError:&err]) {
        [self emit:@{ @"type" : @"state", @"state" : @"error",
                      @"detail" : err.localizedDescription ?: @"engine start" }];
        [self teardown];
        return;
    }
    self.active = YES;
    [self emit:@{ @"type" : @"state", @"state" : @"listening" }];
}

- (void)stop {
    if (!self.active) return;
    self.active = NO;                 // 탭 콜백 중단
    [self.engine.inputNode removeTapOnBus:0];
    [self.engine stop];
    [self.req endAudio];              // task는 살려둔다 — final이 곧 도착
}

- (void)cancel {
    [self teardown];
}

- (void)teardown {
    self.cancelled = YES;
    if (self.active) {
        [self.engine.inputNode removeTapOnBus:0];
        [self.engine stop];
        self.active = NO;
    }
    [self.task cancel];
    self.task = nil;
    self.req = nil;
    self.engine = nil;
}

@end
