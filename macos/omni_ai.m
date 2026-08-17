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
@end

@implementation OmniAIListener

- (instancetype)init {
    if ((self = [super init])) {
        _rec = [[SFSpeechRecognizer alloc] initWithLocale:
            [NSLocale localeWithLocaleIdentifier:@"ko-KR"]];
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

- (void)start {
    if (self.active) return;
    if (self.rec == nil || !self.rec.isAvailable) {
        [self emit:@{ @"type" : @"state", @"state" : @"unavailable" }];
        return;
    }
    self.cancelled = NO;
    // 엔진은 매 세션 새로 만든다 — 권한 승인 전에 잡은 입력 포맷이
    // 0Hz로 남는 문제를 피하기 위함
    self.engine = [[AVAudioEngine alloc] init];
    self.req = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    self.req.shouldReportPartialResults = YES;
    if (self.rec.supportsOnDeviceRecognition) {
        self.req.requiresOnDeviceRecognition = YES;
    }

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
        [s.req appendAudioPCMBuffer:buf];
        float *ch = buf.floatChannelData ? buf.floatChannelData[0] : NULL;
        if (ch != NULL && buf.frameLength > 0 && (s.levelCount++ % 3) == 0) {
            float acc = 0;
            for (AVAudioFrameCount i = 0; i < buf.frameLength; i++) acc += ch[i] * ch[i];
            [s emit:@{ @"type" : @"level",
                       @"rms" : @(sqrtf(acc / buf.frameLength)) }];
        }
    }];

    self.task = [self.rec recognitionTaskWithRequest:self.req
        resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        typeof(self) s = weakSelf;
        if (s == nil || s.cancelled) return;
        if (result != nil) {
            NSString *text = result.bestTranscription.formattedString ?: @"";
            [s emit:@{ @"type" : result.isFinal ? @"final" : @"partial",
                       @"text" : text }];
            if (result.isFinal) [s teardown];
        }
        if (error != nil) {
            // stop() 후 인식할 발화가 없으면 결과 대신 에러(216 등)로 끝난다
            // → 빈 final로 취급해 JS 쪽 대기를 풀어준다
            [s emit:@{ @"type" : @"final", @"text" : @"" }];
            [s teardown];
        }
    }];

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
