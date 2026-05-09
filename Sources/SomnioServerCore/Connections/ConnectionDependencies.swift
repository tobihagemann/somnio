import Logging
import SomnioData

/// Bag of dependencies the `ConnectionActor` consumes. Repositories are protocol-typed
/// (`AccountRepository`, `CharacterRepository`, `InventoryRepository`,
/// `RegistrationRepository`) so they can be substituted in unit tests; the rest are concrete
/// types whose construction is straightforward and not stubbed in current tests. The bag's
/// purpose is to let tests instantiate the connection actor without spinning up a Hummingbird
/// server.
public struct ConnectionDependencies: Sendable {
    public let accounts: any AccountRepository
    public let characters: any CharacterRepository
    public let inventories: any InventoryRepository
    public let registrations: any RegistrationRepository
    public let passwordHasher: PasswordHasher
    public let worldRouter: WorldRouter
    public let worldClock: WorldClockService
    public let configuration: ServerConfiguration
    public let logger: Logger

    public init(
        accounts: any AccountRepository,
        characters: any CharacterRepository,
        inventories: any InventoryRepository,
        registrations: any RegistrationRepository,
        passwordHasher: PasswordHasher,
        worldRouter: WorldRouter,
        worldClock: WorldClockService,
        configuration: ServerConfiguration,
        logger: Logger
    ) {
        self.accounts = accounts
        self.characters = characters
        self.inventories = inventories
        self.registrations = registrations
        self.passwordHasher = passwordHasher
        self.worldRouter = worldRouter
        self.worldClock = worldClock
        self.configuration = configuration
        self.logger = logger
    }
}
