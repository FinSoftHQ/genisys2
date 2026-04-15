package com.example

import com.example.utils.StringUtils
import com.example.utils.ValidationUtils
import kotlinx.coroutines.*

/**
 * Main entry point for the Kotlin application.
 *
 * This application demonstrates various Kotlin features including
 * coroutines, data classes, sealed classes, and extension functions.
 *
 * @author Test Author
 * @since 1.0.0
 */
object ApplicationConfig {
    const val APP_NAME = "KotlinTestApp"
    const val VERSION = "1.0.0"
    const val DEFAULT_TIMEOUT = 5000L
}

/**
 * Data class representing a user in the system.
 *
 * @property id Unique user identifier
 * @property name User's full name
 * @property email User's email address
 * @property age User's age
 */
data class User(
    val id: String,
    val name: String,
    val email: String,
    val age: Int
) {
    /**
     * Check if user is an adult.
     * @return true if age >= 18
     */
    fun isAdult(): Boolean = age >= 18

    /**
     * Get display name for the user.
     * @return formatted display name
     */
    fun getDisplayName(): String = "$name ($email)"
}

/**
 * Sealed class representing different types of API responses.
 */
sealed class ApiResponse<out T> {
    /**
     * Successful response with data.
     */
    data class Success<T>(val data: T, val timestamp: Long = System.currentTimeMillis()) : ApiResponse<T>()

    /**
     * Error response with message.
     */
    data class Error(val message: String, val code: Int) : ApiResponse<Nothing>()

    /**
     * Loading state.
     */
    data object Loading : ApiResponse<Nothing>()
}

/**
 * Interface for data repository operations.
 */
interface Repository<T> {
    /**
     * Find entity by ID.
     * @param id Entity identifier
     * @return Entity or null if not found
     */
    suspend fun findById(id: String): T?

    /**
     * Find all entities.
     * @return List of all entities
     */
    suspend fun findAll(): List<T>

    /**
     * Save an entity.
     * @param entity Entity to save
     * @return Saved entity
     */
    suspend fun save(entity: T): T

    /**
     * Delete an entity by ID.
     * @param id Entity identifier
     * @return true if deleted
     */
    suspend fun delete(id: String): Boolean
}

/**
 * User repository implementation.
 */
class UserRepository : Repository<User> {
    private val users = mutableMapOf<String, User>()

    override suspend fun findById(id: String): User? {
        delay(100) // Simulate network delay
        return users[id]
    }

    override suspend fun findAll(): List<User> {
        delay(100)
        return users.values.toList()
    }

    override suspend fun save(entity: User): User {
        delay(100)
        users[entity.id] = entity
        return entity
    }

    override suspend fun delete(id: String): Boolean {
        delay(100)
        return users.remove(id) != null
    }

    /**
     * Find users by name pattern.
     * @param pattern Name pattern to search
     * @return Matching users
     */
    suspend fun findByName(pattern: String): List<User> {
        delay(100)
        return users.values.filter { it.name.contains(pattern, ignoreCase = true) }
    }
}

/**
 * Service class for user operations.
 *
 * @property repository User repository instance
 */
class UserService(private val repository: UserRepository) {

    /**
     * Get all users.
     * @return API response with user list
     */
    suspend fun getAllUsers(): ApiResponse<List<User>> {
        return try {
            val users = repository.findAll()
            ApiResponse.Success(users)
        } catch (e: Exception) {
            ApiResponse.Error(e.message ?: "Unknown error", 500)
        }
    }

    /**
     * Get user by ID.
     * @param id User identifier
     * @return API response with user or error
     */
    suspend fun getUser(id: String): ApiResponse<User> {
        return try {
            val user = repository.findById(id)
            if (user != null) {
                ApiResponse.Success(user)
            } else {
                ApiResponse.Error("User not found", 404)
            }
        } catch (e: Exception) {
            ApiResponse.Error(e.message ?: "Unknown error", 500)
        }
    }

    /**
     * Create a new user.
     * @param name User name
     * @param email User email
     * @param age User age
     * @return API response with created user
     */
    suspend fun createUser(name: String, email: String, age: Int): ApiResponse<User> {
        if (!ValidationUtils.isValidEmail(email)) {
            return ApiResponse.Error("Invalid email", 400)
        }
        if (!ValidationUtils.isValidAge(age)) {
            return ApiResponse.Error("Invalid age", 400)
        }

        val user = User(
            id = StringUtils.generateId(),
            name = name,
            email = email,
            age = age
        )

        return try {
            val saved = repository.save(user)
            ApiResponse.Success(saved)
        } catch (e: Exception) {
            ApiResponse.Error(e.message ?: "Failed to create user", 500)
        }
    }
}

/**
 * Main application class.
 */
class Application(private val userService: UserService) {
    private val scope = CoroutineScope(Dispatchers.Default + Job())

    /**
     * Start the application.
     */
    fun start() {
        println("Starting ${ApplicationConfig.APP_NAME} v${ApplicationConfig.VERSION}")
        scope.launch {
            runExample()
        }
    }

    /**
     * Stop the application.
     */
    fun stop() {
        println("Stopping application...")
        scope.cancel()
    }

    private suspend fun runExample() {
        // Create some users
        val response1 = userService.createUser("John Doe", "john@example.com", 30)
        val response2 = userService.createUser("Jane Smith", "jane@example.com", 25)

        println("Created users: $response1, $response2")

        // Get all users
        val allUsers = userService.getAllUsers()
        println("All users: $allUsers")
    }
}

/**
 * Main entry point.
 */
fun main() = runBlocking {
    val repository = UserRepository()
    val service = UserService(repository)
    val app = Application(service)

    app.start()
    delay(2000)
    app.stop()
}
