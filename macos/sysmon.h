#import <Foundation/Foundation.h>

// 시스템 지표 스냅샷 수집 (CPU/GPU/RAM/네트워크/디스크/배터리/열/프로세스).
// 호출 간 델타(코어 틱, 바이트 카운터)는 내부 static으로 유지되므로
// 주기적으로(1초) 같은 프로세스에서 호출해야 rate가 정확하다.
NSDictionary *SysmonCollect(void);
