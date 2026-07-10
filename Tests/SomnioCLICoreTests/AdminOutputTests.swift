import Foundation
import SomnioCatalogTestSupport
import SomnioProtocol
import Testing
@testable import SomnioCLICore

struct AdminOutputTests {
    private let en = Locale(identifier: "en_US")

    @Test func `logEmpty renders English`() {
        #expect(AdminOutput.render(.logEmpty, locale: en) == "Log file is empty or does not exist.")
    }

    @Test func `logRemoved renders English`() {
        #expect(AdminOutput.render(.logRemoved, locale: en) == "Log file deleted.")
    }

    @Test func `weblogEmpty renders English`() {
        #expect(AdminOutput.render(.weblogEmpty, locale: en) == "WebLog file is empty or does not exist.")
    }

    @Test func `weblogRemoved renders English`() {
        #expect(AdminOutput.render(.weblogRemoved, locale: en) == "WebLog file deleted.")
    }

    @Test func `unknownCommand renders English`() {
        #expect(AdminOutput.render(.unknownCommand, locale: en) == "Unknown command.")
    }

    @Test func `logContents passes the body through verbatim`() {
        #expect(AdminOutput.render(.logContents(text: "raw\nbody"), locale: en) == "raw\nbody")
    }

    @Test func `weblogContents passes the body through verbatim`() {
        #expect(AdminOutput.render(.weblogContents(text: "admin\nbody"), locale: en) == "admin\nbody")
    }

    @Test func `playerCount substitutes the count`() {
        #expect(AdminOutput.render(.playerCount(text: "12"), locale: en) == "Number of players on the server: 12")
    }

    @Test func `sayBroadcast substitutes the message`() {
        #expect(AdminOutput.render(.sayBroadcast(text: "hi"), locale: en) == "Broadcast message: hi")
    }

    @Test func `kickedPlayer substitutes the name`() {
        #expect(AdminOutput.render(.kickedPlayer(text: "Saibot"), locale: en) == "Saibot was kicked from the server.")
    }

    @Test func `kickedPlayerNotFound substitutes the name`() {
        #expect(AdminOutput.render(.kickedPlayerNotFound(text: "Eve"), locale: en) == "Eve could not be found on the server.")
    }

    @Test func `versionString substitutes the version`() {
        #expect(AdminOutput.render(.versionString(text: "1.0.0"), locale: en) == "The server is running version: 1.0.0")
    }

    @Test func `worldClock parse success renders the full template under English`() {
        let result = AdminOutput.render(.worldClock(text: "1;2;3;04;05;06"), locale: en)
        #expect(result == "It is the year 1, the month 2, the day 3 and the time is 04:05:06.")
    }

    // SwiftPM `.process`-resourced `.xcstrings` files ship the raw JSON in
    // `Bundle.module`; SwiftPM does not compile them into per-locale `.lproj/.strings`
    // artifacts, so Foundation's `String(localized:bundle:locale:)` cannot switch
    // languages at runtime from a unit-test process. The German catalog is therefore
    // pinned at the JSON level — proves the strings are present and exposes broken
    // positional placeholders that would silently fall back to EN at run time.

    @Test func `german worldClock template carries the correct positional placeholders`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.module)
        let key = "It is the year %1$@, the month %2$@, the day %3$@ and the time is %4$@:%5$@:%6$@."
        let de = try #require(catalog[key]?["de"])
        #expect(de == "Wir schreiben das Jahr %1$@, den Monat %2$@, den Tag %3$@ und es ist %4$@:%5$@:%6$@ Uhr.")
    }

    @Test func `worldClock parse failure on too few fields renders the error template`() {
        let result = AdminOutput.render(.worldClock(text: "1;2;3;4;5"), locale: en)
        #expect(result == "The error 1;2;3;4;5 occurred.")
    }

    @Test func `worldClock parse failure on non numeric fields renders the error template`() {
        let result = AdminOutput.render(.worldClock(text: "a;b;c;d;e;f"), locale: en)
        #expect(result == "The error a;b;c;d;e;f occurred.")
    }

    @Test func `worldClock parse failure on completely malformed text renders the error template`() {
        let result = AdminOutput.render(.worldClock(text: "malformed"), locale: en)
        #expect(result == "The error malformed occurred.")
    }

    @Test func `parseWorldClock returns six raw substrings on success`() throws {
        let parsed = try #require(AdminOutput.parseWorldClock("10;20;30;04;05;06"))
        #expect(parsed.year == "10")
        #expect(parsed.month == "20")
        #expect(parsed.day == "30")
        #expect(parsed.hour == "04")
        #expect(parsed.minute == "05")
        #expect(parsed.second == "06")
    }

    @Test func `parseWorldClock rejects field count not equal to six`() {
        #expect(AdminOutput.parseWorldClock("1;2;3;4;5") == nil)
        #expect(AdminOutput.parseWorldClock("1;2;3;4;5;6;7") == nil)
    }

    @Test func `parseWorldClock rejects non integer fields`() {
        #expect(AdminOutput.parseWorldClock("a;2;3;4;5;6") == nil)
    }

    @Test func `every catalog key carries an English and German translation`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.module)
        let expectedKeys = [
            "%@ could not be found on the server.",
            "%@ was kicked from the server.",
            "Broadcast message: %@",
            "It is the year %1$@, the month %2$@, the day %3$@ and the time is %4$@:%5$@:%6$@.",
            "Log file deleted.",
            "Log file is empty or does not exist.",
            "Number of players on the server: %@",
            "Successfully logged into the server.",
            "The error %@ occurred.",
            "The server is running version: %@",
            "Unknown command.",
            "WebLog file deleted.",
            "WebLog file is empty or does not exist.",
            "Welcome to the Somnio Console!"
        ]
        for key in expectedKeys {
            let entry = try #require(catalog[key], "missing catalog entry for \(key)")
            #expect(entry["en"]?.isEmpty == false, "missing English value for \(key)")
            #expect(entry["de"]?.isEmpty == false, "missing German value for \(key)")
        }
    }

    @Test func `every catalog key doubles as its own English value for the Linux key fallback`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.module)
        try assertKeysAreEnglishFallback(catalog)
    }
}
