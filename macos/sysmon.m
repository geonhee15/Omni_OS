#import "sysmon.h"
#import <mach/mach.h>
#import <mach/processor_info.h>
#import <mach/mach_host.h>
#import <sys/sysctl.h>
#import <sys/mount.h>
#import <ifaddrs.h>
#import <net/if.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/ps/IOPowerSources.h>
#import <IOKit/ps/IOPSKeys.h>

// ── CPU: 코어별 사용률 (틱 델타) ──
static NSArray *SysmonCPU(double *totalOut) {
    static processor_cpu_load_info_t prev = NULL;
    static natural_t prevCount = 0;

    processor_cpu_load_info_t info;
    mach_msg_type_number_t infoCnt;
    natural_t count;
    kern_return_t kr = host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO,
                                           &count, (processor_info_array_t *)&info,
                                           &infoCnt);
    if (kr != KERN_SUCCESS) return @[];

    NSMutableArray *cores = [NSMutableArray array];
    double sum = 0;
    for (natural_t i = 0; i < count; i++) {
        double usage = 0;
        if (prev != NULL && i < prevCount) {
            uint64_t busy = 0, total = 0;
            for (int s = 0; s < CPU_STATE_MAX; s++) {
                uint64_t d = info[i].cpu_ticks[s] - prev[i].cpu_ticks[s];
                total += d;
                if (s != CPU_STATE_IDLE) busy += d;
            }
            usage = total > 0 ? (double)busy / (double)total : 0;
        }
        sum += usage;
        [cores addObject:@(usage)];
    }
    if (prev != NULL) {
        vm_deallocate(mach_task_self(), (vm_address_t)prev,
                      prevCount * sizeof(*prev));
    }
    prev = info;
    prevCount = count;
    *totalOut = count > 0 ? sum / count : 0;
    return cores;
}

// ── 메모리 구성 ──
static NSDictionary *SysmonMem(void) {
    vm_statistics64_data_t vm;
    mach_msg_type_number_t cnt = HOST_VM_INFO64_COUNT;
    if (host_statistics64(mach_host_self(), HOST_VM_INFO64,
                          (host_info64_t)&vm, &cnt) != KERN_SUCCESS) return @{};
    vm_size_t page;
    host_page_size(mach_host_self(), &page);
    uint64_t total = 0;
    size_t len = sizeof(total);
    sysctlbyname("hw.memsize", &total, &len, NULL, 0);

    uint32_t pressure = 1;
    len = sizeof(pressure);
    sysctlbyname("kern.memorystatus_vm_pressure_level", &pressure, &len, NULL, 0);

    uint64_t wired = (uint64_t)vm.wire_count * page;
    uint64_t compressed = (uint64_t)vm.compressor_page_count * page;
    uint64_t active = (uint64_t)vm.active_count * page;
    uint64_t inactive = (uint64_t)vm.inactive_count * page;
    uint64_t freeB = ((uint64_t)vm.free_count + (uint64_t)vm.speculative_count) * page;
    return @{
        @"total" : @(total),
        @"wired" : @(wired),
        @"compressed" : @(compressed),
        @"active" : @(active),
        @"inactive" : @(inactive),
        @"free" : @(freeB),
        @"pressure" : @(pressure),
    };
}

// ── GPU 사용률 (IOAccelerator PerformanceStatistics — 되는 기기에서만) ──
static NSNumber *SysmonGPU(void) {
    io_iterator_t it;
    if (IOServiceGetMatchingServices(kIOMainPortDefault,
            IOServiceMatching("IOAccelerator"), &it) != KERN_SUCCESS) return nil;
    NSNumber *result = nil;
    io_object_t obj;
    while ((obj = IOIteratorNext(it))) {
        CFMutableDictionaryRef props = NULL;
        if (IORegistryEntryCreateCFProperties(obj, &props, kCFAllocatorDefault, 0)
                == KERN_SUCCESS && props != NULL) {
            NSDictionary *d = CFBridgingRelease(props);
            NSDictionary *stats = d[@"PerformanceStatistics"];
            id util = stats[@"Device Utilization %"];
            if ([util isKindOfClass:[NSNumber class]]) result = util;
        }
        IOObjectRelease(obj);
        if (result != nil) break;
    }
    IOObjectRelease(it);
    return result;
}

// ── 네트워크: en* 인터페이스 누적 바이트 → rate ──
static NSDictionary *SysmonNet(void) {
    static uint64_t prevRx = 0, prevTx = 0;
    static double prevAt = 0;

    uint64_t rx = 0, tx = 0;
    struct ifaddrs *ifs = NULL;
    if (getifaddrs(&ifs) == 0) {
        for (struct ifaddrs *p = ifs; p != NULL; p = p->ifa_next) {
            if (p->ifa_addr == NULL || p->ifa_addr->sa_family != AF_LINK) continue;
            if (strncmp(p->ifa_name, "en", 2) != 0) continue;
            struct if_data *d = (struct if_data *)p->ifa_data;
            if (d == NULL) continue;
            rx += d->ifi_ibytes;
            tx += d->ifi_obytes;
        }
        freeifaddrs(ifs);
    }
    double now = [NSDate date].timeIntervalSince1970;
    double rxRate = 0, txRate = 0;
    if (prevAt > 0 && now > prevAt && rx >= prevRx && tx >= prevTx) {
        rxRate = (double)(rx - prevRx) / (now - prevAt);
        txRate = (double)(tx - prevTx) / (now - prevAt);
    }
    prevRx = rx;
    prevTx = tx;
    prevAt = now;
    return @{ @"rxRate" : @(rxRate), @"txRate" : @(txRate) };
}

// ── 디스크: 사용량 + 블록 드라이버 R/W rate ──
static NSDictionary *SysmonDisk(void) {
    static uint64_t prevRead = 0, prevWrite = 0;
    static double prevAt = 0;

    struct statfs fs;
    uint64_t total = 0, freeB = 0;
    if (statfs("/", &fs) == 0) {
        total = (uint64_t)fs.f_blocks * fs.f_bsize;
        // 데이터 볼륨의 여유가 실제 체감 여유 공간
        struct statfs data;
        if (statfs("/System/Volumes/Data", &data) == 0) {
            freeB = (uint64_t)data.f_bavail * data.f_bsize;
        } else {
            freeB = (uint64_t)fs.f_bavail * fs.f_bsize;
        }
    }

    uint64_t rd = 0, wr = 0;
    io_iterator_t it;
    if (IOServiceGetMatchingServices(kIOMainPortDefault,
            IOServiceMatching("IOBlockStorageDriver"), &it) == KERN_SUCCESS) {
        io_object_t obj;
        while ((obj = IOIteratorNext(it))) {
            CFMutableDictionaryRef props = NULL;
            if (IORegistryEntryCreateCFProperties(obj, &props, kCFAllocatorDefault, 0)
                    == KERN_SUCCESS && props != NULL) {
                NSDictionary *d = CFBridgingRelease(props);
                NSDictionary *stats = d[@"Statistics"];
                rd += [stats[@"Bytes (Read)"] unsignedLongLongValue];
                wr += [stats[@"Bytes (Write)"] unsignedLongLongValue];
            }
            IOObjectRelease(obj);
        }
        IOObjectRelease(it);
    }
    double now = [NSDate date].timeIntervalSince1970;
    double rdRate = 0, wrRate = 0;
    if (prevAt > 0 && now > prevAt && rd >= prevRead && wr >= prevWrite) {
        rdRate = (double)(rd - prevRead) / (now - prevAt);
        wrRate = (double)(wr - prevWrite) / (now - prevAt);
    }
    prevRead = rd;
    prevWrite = wr;
    prevAt = now;
    return @{
        @"total" : @(total),
        @"free" : @(freeB),
        @"readRate" : @(rdRate),
        @"writeRate" : @(wrRate),
    };
}

// ── 배터리 (없으면 nil) ──
static NSDictionary *SysmonBattery(void) {
    CFTypeRef info = IOPSCopyPowerSourcesInfo();
    if (info == NULL) return nil;
    CFArrayRef list = IOPSCopyPowerSourcesList(info);
    NSDictionary *result = nil;
    if (list != NULL && CFArrayGetCount(list) > 0) {
        CFDictionaryRef ps = IOPSGetPowerSourceDescription(
            info, CFArrayGetValueAtIndex(list, 0));
        if (ps != NULL) {
            NSDictionary *d = (__bridge NSDictionary *)ps;
            NSMutableDictionary *b = [NSMutableDictionary dictionary];
            b[@"percent"] = d[@kIOPSCurrentCapacityKey] ?: @(-1);
            b[@"charging"] = @([d[@kIOPSIsChargingKey] boolValue]);
            b[@"external"] = @([d[@kIOPSPowerSourceStateKey]
                isEqualToString:@kIOPSACPowerValue]);
            b[@"timeToEmpty"] = d[@kIOPSTimeToEmptyKey] ?: @(-1);
            b[@"timeToFull"] = d[@kIOPSTimeToFullChargeKey] ?: @(-1);

            // 사이클/건강 상태는 IORegistry의 AppleSmartBattery에서
            io_service_t bat = IOServiceGetMatchingService(kIOMainPortDefault,
                IOServiceMatching("AppleSmartBattery"));
            if (bat != IO_OBJECT_NULL) {
                CFMutableDictionaryRef props = NULL;
                if (IORegistryEntryCreateCFProperties(bat, &props,
                        kCFAllocatorDefault, 0) == KERN_SUCCESS && props != NULL) {
                    NSDictionary *p = CFBridgingRelease(props);
                    b[@"cycles"] = p[@"CycleCount"] ?: @(-1);
                    double design = [p[@"DesignCapacity"] doubleValue];
                    double maxCap = [p[@"AppleRawMaxCapacity"] doubleValue];
                    if (maxCap <= 0) maxCap = [p[@"NominalChargeCapacity"] doubleValue];
                    if (design > 0 && maxCap > 0) {
                        b[@"health"] = @(maxCap / design);
                    }
                }
                IOObjectRelease(bat);
            }
            result = b;
        }
    }
    if (list != NULL) CFRelease(list);
    CFRelease(info);
    return result;
}

// ── 프로세스 TOP (ps — 추가 권한 불필요) ──
static NSArray *SysmonTop(void) {
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/ps"];
    task.arguments = @[ @"-Aceo", @"pid,pcpu,pmem,comm", @"-r" ];
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = [NSPipe pipe];
    NSError *err = nil;
    if (![task launchAndReturnError:&err]) return @[];
    NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    NSString *out = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];

    NSMutableArray *rows = [NSMutableArray array];
    NSArray *lines = [out componentsSeparatedByString:@"\n"];
    for (NSUInteger i = 1; i < lines.count && rows.count < 8; i++) {
        NSString *line = [lines[i] stringByTrimmingCharactersInSet:
            NSCharacterSet.whitespaceCharacterSet];
        if (line.length == 0) continue;
        NSScanner *sc = [NSScanner scannerWithString:line];
        int pid;
        double cpu, mem;
        if (![sc scanInt:&pid] || ![sc scanDouble:&cpu] || ![sc scanDouble:&mem]) continue;
        NSString *name = [[line substringFromIndex:sc.scanLocation]
            stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (name.length == 0) continue;
        [rows addObject:@{ @"pid" : @(pid), @"cpu" : @(cpu),
                           @"mem" : @(mem), @"name" : name }];
    }
    return rows;
}

static NSString *SysmonSysctlStr(const char *key) {
    char buf[256] = {0};
    size_t len = sizeof(buf) - 1;
    if (sysctlbyname(key, buf, &len, NULL, 0) != 0) return @"";
    return [NSString stringWithUTF8String:buf] ?: @"";
}

NSDictionary *SysmonCollect(void) {
    NSMutableDictionary *out = [NSMutableDictionary dictionary];

    double cpuTotal = 0;
    out[@"cores"] = SysmonCPU(&cpuTotal);
    out[@"cpu"] = @(cpuTotal);
    out[@"cpuModel"] = SysmonSysctlStr("machdep.cpu.brand_string");

    double load[3] = {0, 0, 0};
    getloadavg(load, 3);
    out[@"load"] = @[ @(load[0]), @(load[1]), @(load[2]) ];

    struct timeval boot;
    size_t len = sizeof(boot);
    if (sysctlbyname("kern.boottime", &boot, &len, NULL, 0) == 0) {
        out[@"uptime"] = @([NSDate date].timeIntervalSince1970 - boot.tv_sec);
    }

    out[@"mem"] = SysmonMem();
    NSNumber *gpu = SysmonGPU();
    if (gpu != nil) out[@"gpu"] = gpu;
    out[@"net"] = SysmonNet();
    out[@"disk"] = SysmonDisk();
    NSDictionary *bat = SysmonBattery();
    if (bat != nil) out[@"battery"] = bat;
    out[@"thermal"] = @(NSProcessInfo.processInfo.thermalState);
    out[@"top"] = SysmonTop();
    out[@"osver"] = NSProcessInfo.processInfo.operatingSystemVersionString ?: @"";
    return out;
}
