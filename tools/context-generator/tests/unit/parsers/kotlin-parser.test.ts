import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import type { SourceFile } from '../../../src/types.js';

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

describe('Kotlin Parser', () => {
  const mockFile = (content: string, path: string = 'test.kt'): SourceFile => ({
    absolutePath: `/project/${path}`,
    relativePath: path,
    extension: path.endsWith('.kts') ? '.kts' : '.kt',
    size: content.length,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-8: Package and Import Extraction', () => {
    it('should extract package declaration', async () => {
      const content = `
package com.example.app

import kotlin.collections.List
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('package com.example.app');
    });

    it('should extract single imports', async () => {
      const content = `
package com.example

import kotlin.collections.List
import kotlin.collections.Map
import java.time.LocalDateTime
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('import kotlin.collections.List');
      expect(result.skeleton).toContain('import kotlin.collections.Map');
      expect(result.skeleton).toContain('import java.time.LocalDateTime');
    });

    it('should extract wildcard imports', async () => {
      const content = `
import kotlinx.coroutines.*
import kotlin.collections.*
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('import kotlinx.coroutines.*');
      expect(result.skeleton).toContain('import kotlin.collections.*');
    });

    it('should extract aliased imports', async () => {
      const content = `
import java.util.Date as JavaDate
import kotlinx.coroutines.flow.Flow as CoroutineFlow
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('import java.util.Date as JavaDate');
    });

    it('should handle imports with backticks', async () => {
      const content = `
import com.example.\`package\`.utils
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('import com.example.`package`.utils');
    });
  });

  describe('AC-8: Class/Object/Interface Extraction', () => {
    it('should extract class declarations', async () => {
      const content = `
class User {
    val name: String = ""
    fun greet(): String = "Hello"
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('class User');
      expect(result.skeleton).toContain('val name: String');
      expect(result.skeleton).toContain('fun greet(): String');
    });

    it('should extract data classes', async () => {
      const content = `
data class User(
    val id: String,
    val name: String,
    val email: String
)
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('data class User');
    });

    it('should extract interface declarations', async () => {
      const content = `
interface Repository<T> {
    suspend fun findById(id: String): T?
    suspend fun findAll(): List<T>
    suspend fun save(entity: T): T
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('interface Repository<T>');
      expect(result.skeleton).toContain('suspend fun findById(id: String): T?');
      expect(result.skeleton).toContain('suspend fun findAll(): List<T>');
    });

    it('should extract object declarations', async () => {
      const content = `
object Config {
    const val API_URL = "https://api.example.com"
    const val TIMEOUT = 5000L
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('object Config');
      expect(result.skeleton).toContain('const val API_URL');
    });

    it('should extract enum classes', async () => {
      const content = `
enum class Status {
    PENDING,
    ACTIVE,
    INACTIVE,
    DELETED
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('enum class Status');
    });

    it('should extract sealed classes', async () => {
      const content = `
sealed class Result<out T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Error(val message: String) : Result<Nothing>()
    data object Loading : Result<Nothing>()
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('sealed class Result<out T>');
    });

    it('should extract abstract classes', async () => {
      const content = `
abstract class BaseService {
    abstract fun process(): Result
    
    fun validate(): Boolean = true
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('abstract class BaseService');
      expect(result.skeleton).toContain('abstract fun process(): Result');
    });

    it('should extract class with inheritance', async () => {
      const content = `
class UserService : BaseService(), ServiceInterface {
    override fun process(): Result {
        return Result.Success
    }
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('class UserService : BaseService(), ServiceInterface');
    });

    it('should extract generic classes', async () => {
      const content = `
class Container<T>(private val value: T) {
    fun get(): T = value
    fun <R> map(transform: (T) -> R): Container<R> = Container(transform(value))
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('class Container<T>');
    });
  });

  describe('AC-8: Function Signature Extraction', () => {
    it('should extract simple function signatures', async () => {
      const content = `
fun greet(name: String): String {
    return "Hello, $name"
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('fun greet(name: String): String { ... }');
    });

    it('should extract suspend function signatures', async () => {
      const content = `
suspend fun fetchData(url: String): Result<Data> {
    delay(1000)
    return api.get(url)
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('suspend fun fetchData(url: String): Result<Data>');
    });

    it('should extract generic function signatures', async () => {
      const content = `
fun <T> identity(value: T): T = value

fun <T, R> T.map(transform: (T) -> R): R = transform(this)
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('fun <T> identity(value: T): T');
    });

    it('should extract function with default parameters', async () => {
      const content = `
fun greet(name: String, greeting: String = "Hello"): String {
    return "$greeting, $name"
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('fun greet(name: String, greeting: String = "Hello")');
    });

    it('should extract abstract function signatures', async () => {
      const content = `
abstract class Service {
    abstract suspend fun process(request: Request): Response
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('abstract suspend fun process(request: Request): Response');
    });

    it('should extract extension functions', async () => {
      const content = `
fun String.addExclamation(): String = this + "!"

fun <T> List<T>.secondOrNull(): T? = if (size > 1) this[1] else null
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('fun String.addExclamation(): String');
      expect(result.skeleton).toContain('fun <T> List<T>.secondOrNull(): T?');
    });

    it('should extract operator functions', async () => {
      const content = `
class Point(val x: Int, val y: Int) {
    operator fun plus(other: Point): Point = Point(x + other.x, y + other.y)
    operator fun get(index: Int): Int = if (index == 0) x else y
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('operator fun plus(other: Point): Point');
      expect(result.skeleton).toContain('operator fun get(index: Int): Int');
    });

    it('should extract inline functions', async () => {
      const content = `
inline fun <T> measureTime(block: () -> T): Pair<T, Long> {
    val start = System.currentTimeMillis()
    return block() to (System.currentTimeMillis() - start)
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('inline fun <T> measureTime(block: () -> T): Pair<T, Long>');
    });
  });

  describe('AC-8: Property Declarations', () => {
    it('should extract val/var declarations', async () => {
      const content = `
val name: String = "Default"
var count: Int = 0
const val MAX_SIZE: Int = 100
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('val name: String');
      expect(result.skeleton).toContain('var count: Int');
      expect(result.skeleton).toContain('const val MAX_SIZE: Int');
    });

    it('should extract lateinit properties', async () => {
      const content = `
class Service {
    lateinit var client: HttpClient
    
    fun init() {
        client = HttpClient()
    }
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('lateinit var client: HttpClient');
    });

    it('should extract delegated properties', async () => {
      const content = `
class User {
    val name: String by lazy { loadName() }
    var email: String by Delegates.observable("") { _, old, new ->
        println("Email changed from $old to $new")
    }
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('val name: String by lazy');
      expect(result.skeleton).toContain('var email: String by Delegates.observable');
    });

    it('should extract abstract properties', async () => {
      const content = `
abstract class Base {
    abstract val requiredValue: String
    abstract var mutableValue: Int
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('abstract val requiredValue: String');
      expect(result.skeleton).toContain('abstract var mutableValue: Int');
    });
  });

  describe('AC-8: Annotations', () => {
    it('should preserve annotations on classes', async () => {
      const content = `
@Entity
@Table(name = "users")
data class User(
    @Id @GeneratedValue
    val id: Long,
    @Column(name = "user_name")
    val name: String
)
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('@Entity');
      expect(result.skeleton).toContain('@Table(name = "users")');
      expect(result.skeleton).toContain('@Id @GeneratedValue');
    });

    it('should preserve annotations on functions', async () => {
      const content = `
@GetMapping("/users")
@PreAuthorize("hasRole('ADMIN')")
suspend fun getUsers(): List<User> {
    return userRepository.findAll()
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('@GetMapping("/users")');
      expect(result.skeleton).toContain('@PreAuthorize');
    });

    it('should preserve annotations on properties', async () => {
      const content = `
class Config {
    @Value("\${app.timeout:5000}")
    val timeout: Long = 5000
    
    @Autowired
    lateinit var service: UserService
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('@Value');
      expect(result.skeleton).toContain('@Autowired');
    });

    it('should preserve annotations with multiple arguments', async () => {
      const content = `
@ApiOperation(
    value = "Get user by ID",
    notes = "Returns a user based on the provided ID",
    response = User::class
)
fun getUser(@PathVariable id: String): User = userService.findById(id)
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('@ApiOperation');
      expect(result.skeleton).toContain('@PathVariable');
    });
  });

  describe('AC-8: KDoc Extraction', () => {
    it('should extract KDoc comments on classes', async () => {
      const content = `
/**
 * Represents a user in the system.
 *
 * @property id Unique identifier
 * @property name User's display name
 * @property email User's email address
 */
data class User(
    val id: String,
    val name: String,
    val email: String
)
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('Represents a user');
    });

    it('should extract KDoc on functions', async () => {
      const content = `
/**
 * Calculate the sum of two numbers.
 *
 * @param a First number
 * @param b Second number
 * @return The sum of a and b
 * @throws IllegalArgumentException if numbers are negative
 */
fun add(a: Int, b: Int): Int = a + b
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('Calculate the sum');
    });

    it('should extract KDoc on properties', async () => {
      const content = `
class Config {
    /** Application timeout in milliseconds */
    val timeout: Long = 5000
    
    /** Maximum retry attempts */
    val maxRetries: Int = 3
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('Application timeout');
      expect(result.skeleton).toContain('Maximum retry attempts');
    });
  });

  describe('Edge Cases', () => {
    it('should handle .kts files (Kotlin scripts)', async () => {
      const content = `
import java.io.File

println("Hello from Kotlin script")

fun greet(name: String): String = "Hello, $name"
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content, 'script.kts'), false);

      expect(result.language).toBe('kotlin');
      expect(result.skeleton).toContain('import java.io.File');
      expect(result.skeleton).toContain('fun greet(name: String): String');
    });

    it('should handle type aliases', async () => {
      const content = `
typealias UserList = List<User>
typealias UserMap = Map<String, User>
typealias Predicate<T> = (T) -> Boolean
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('typealias UserList = List<User>');
      expect(result.skeleton).toContain('typealias UserMap = Map<String, User>');
    });

    it('should handle companion objects', async () => {
      const content = `
class User {
    companion object {
        const val DEFAULT_NAME = "Unknown"
        fun createGuest(): User = User(DEFAULT_NAME)
    }
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('companion object');
      expect(result.skeleton).toContain('const val DEFAULT_NAME');
    });

    it('should handle init blocks', async () => {
      const content = `
class Service {
    init {
        initialize()
    }
    
    fun initialize() {}
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toContain('init');
    });

    it('should handle empty files', async () => {
      const content = '';
      (readFileSync as any).mockReturnValue(content);

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(mockFile(content), false);

      expect(result.skeleton).toBeDefined();
      expect(result.language).toBe('kotlin');
    });

    it('should include source file info', async () => {
      const content = '';
      (readFileSync as any).mockReturnValue(content);
      const file = mockFile(content, 'Module.kt');

      const { parseKotlin } = await import('../../../src/parsers/kotlin.js');
      const result = await parseKotlin(file, false);

      expect(result.sourceFile).toEqual(file);
    });
  });
});
