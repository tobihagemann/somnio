import Foundation

/// Server-owned in-game world clock. Advances at 4× wall clock; 60 sec/min, 60 min/hr,
/// 24 hr/day, 28 days/month, 12 months/year.
///
/// Rollover is **legacy-faithful and atomic**: the original server increments the hour,
/// sends the wire packet with the incremented value, *then* applies the rollover. So one
/// tick at midnight: the wire emission carries `hour = 24` while the post-tick internal
/// state is `hour = 0, day += 1`.
///
/// `tick()` advances internal state to its post-rollover value and returns the `WireTime`
/// the server should emit on the wire.
public struct WorldClock: Sendable, Equatable, Hashable {
    public var second: Int16
    public var minute: Int16
    public var hour: Int16
    public var day: Int16
    public var month: Int16
    public var year: Int16

    public static let bootDefault = WorldClock(
        second: 0, minute: 0, hour: 12, day: 1, month: 1, year: 500
    )

    public init(second: Int16, minute: Int16, hour: Int16, day: Int16, month: Int16, year: Int16) {
        self.second = second
        self.minute = minute
        self.hour = hour
        self.day = day
        self.month = month
        self.year = year
    }

    public struct WireTime: Sendable, Equatable, Hashable {
        public var hour: Int16
        public var minute: Int16

        public init(hour: Int16, minute: Int16) {
            self.hour = hour
            self.minute = minute
        }
    }

    /// Advance by one in-game second. Returns the wire-emission `WireTime` for this tick;
    /// at midnight, `WireTime.hour == 24` even though `self.hour == 0` after the call.
    public mutating func tick() -> WireTime {
        second += 1
        if second == 60 {
            second = 0
            minute += 1
            if minute == 60 {
                minute = 0
                hour += 1
                let wire = WireTime(hour: hour, minute: minute)
                if hour == 24 {
                    hour = 0
                    day += 1
                    if day == 29 {
                        day = 1
                        month += 1
                        if month == 13 {
                            month = 1
                            year += 1
                        }
                    }
                }
                return wire
            }
        }
        return WireTime(hour: hour, minute: minute)
    }
}
