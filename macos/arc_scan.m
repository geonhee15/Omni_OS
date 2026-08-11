#import "arc_scan.h"
#import <arpa/inet.h>
#import <ifaddrs.h>
#import <net/if.h>   // IFF_UP / IFF_LOOPBACK
#import <netinet/in.h>
#import <netinet/tcp.h>
#import <sys/socket.h>
#import <fcntl.h>
#import <unistd.h>

#ifndef ARC_PORT_NUM
#define ARC_PORT_NUM 81   // overridable so tests can run without root (<1024)
#endif
static const int ARC_PORT = ARC_PORT_NUM;

// Local IPv4 addresses on non-loopback interfaces, as "a.b.c.d".
static NSArray<NSString *> *localIPv4Addresses(void) {
    NSMutableArray<NSString *> *out = [NSMutableArray array];
    struct ifaddrs *head = NULL;
    if (getifaddrs(&head) != 0) return out;
    for (struct ifaddrs *ifa = head; ifa != NULL; ifa = ifa->ifa_next) {
        if (ifa->ifa_addr == NULL || ifa->ifa_addr->sa_family != AF_INET) continue;
        if ((ifa->ifa_flags & IFF_UP) == 0 || (ifa->ifa_flags & IFF_LOOPBACK)) continue;
        char buf[INET_ADDRSTRLEN] = {0};
        struct sockaddr_in *sin = (struct sockaddr_in *)ifa->ifa_addr;
        if (inet_ntop(AF_INET, &sin->sin_addr, buf, sizeof(buf)) == NULL) continue;
        NSString *ip = [NSString stringWithUTF8String:buf];
        if (ip.length && ![ip hasPrefix:@"169.254."]) [out addObject:ip];
    }
    freeifaddrs(head);
    return out;
}

// Non-blocking connect with timeout — true if the TCP port accepts.
static BOOL portOpen(const char *ip, int port, double timeoutSec) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return NO;
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    if (inet_pton(AF_INET, ip, &addr.sin_addr) != 1) { close(fd); return NO; }

    BOOL ok = NO;
    int rc = connect(fd, (struct sockaddr *)&addr, sizeof(addr));
    if (rc == 0) {
        ok = YES;
    } else if (errno == EINPROGRESS) {
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(fd, &wfds);
        struct timeval tv = {
            .tv_sec = (time_t)timeoutSec,
            .tv_usec = (suseconds_t)((timeoutSec - (long)timeoutSec) * 1e6),
        };
        if (select(fd + 1, NULL, &wfds, NULL, &tv) > 0) {
            int err = 0;
            socklen_t len = sizeof(err);
            if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) == 0 && err == 0) ok = YES;
        }
    }
    close(fd);
    return ok;
}

// Opens a WebSocket and waits briefly for a frame shaped like arc-scan data.
static BOOL looksLikeArcScan(NSString *ip) {
    NSURL *url = [NSURL URLWithString:
        [NSString stringWithFormat:@"ws://%@:%d", ip, ARC_PORT]];
    NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    cfg.timeoutIntervalForRequest = 3.0;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:cfg];
    NSURLSessionWebSocketTask *task = [session webSocketTaskWithURL:url];
    [task resume];

    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block BOOL match = NO;
    [task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *msg, NSError *error) {
        if (error == nil && msg.type == NSURLSessionWebSocketMessageTypeString) {
            NSData *d = [msg.string dataUsingEncoding:NSUTF8StringEncoding];
            id j = d ? [NSJSONSerialization JSONObjectWithData:d options:0 error:nil] : nil;
            if ([j isKindOfClass:[NSDictionary class]] &&
                [j[@"d"] isKindOfClass:[NSArray class]] &&
                [(NSArray *)j[@"d"] count] >= 1 &&
                j[@"a"] != nil) {
                match = YES;
            }
        }
        dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.5 * NSEC_PER_SEC)));
    [task cancel];
    [session invalidateAndCancel];
    return match;
}

NSArray<NSDictionary *> *ARCScanDevices(void) {
    NSMutableArray<NSString *> *candidates = [NSMutableArray array];
    NSMutableSet<NSString *> *seen = [NSMutableSet set];

    for (NSString *self_ip in localIPv4Addresses()) {
        NSArray<NSString *> *parts = [self_ip componentsSeparatedByString:@"."];
        if (parts.count != 4) continue;
        NSString *prefix = [NSString stringWithFormat:@"%@.%@.%@.",
                            parts[0], parts[1], parts[2]];

        // fan out the /24 with a bounded concurrent queue
        dispatch_queue_t q = dispatch_queue_create("arc.scan", DISPATCH_QUEUE_CONCURRENT);
        dispatch_group_t grp = dispatch_group_create();
        dispatch_semaphore_t slots = dispatch_semaphore_create(64);
        NSLock *lock = [NSLock new];

        for (int host = 1; host <= 254; host++) {
            NSString *ip = [prefix stringByAppendingFormat:@"%d", host];
            if ([ip isEqualToString:self_ip]) continue;
            dispatch_semaphore_wait(slots, DISPATCH_TIME_FOREVER);
            dispatch_group_async(grp, q, ^{
                if (portOpen(ip.UTF8String, ARC_PORT, 0.6)) {
                    [lock lock];
                    if (![seen containsObject:ip]) {
                        [seen addObject:ip];
                        [candidates addObject:ip];
                    }
                    [lock unlock];
                }
                dispatch_semaphore_signal(slots);
            });
        }
        dispatch_group_wait(grp, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(12 * NSEC_PER_SEC)));
    }

    // confirm each candidate actually speaks the arc-scan protocol
    NSMutableArray<NSDictionary *> *verified = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *others = [NSMutableArray array];
    for (NSString *ip in candidates) {
        BOOL ok = looksLikeArcScan(ip);
        [(ok ? verified : others) addObject:@{ @"ip" : ip, @"verified" : @(ok) }];
    }
    [verified addObjectsFromArray:others];
    return verified;
}
