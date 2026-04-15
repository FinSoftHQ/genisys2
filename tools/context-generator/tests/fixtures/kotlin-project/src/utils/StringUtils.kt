package com.example.utils

import java.security.MessageDigest
import java.util.UUID

/**
 * Utility functions for string manipulation.
 *
 * This object provides various extension functions and utilities
 * for working with strings in Kotlin.
 */
object StringUtils {

    /**
     * Generate a random unique identifier.
     * @return Random UUID string
     */
    fun generateId(): String = UUID.randomUUID().toString()

    /**
     * Generate a short ID (first 8 chars of UUID).
     * @return Short identifier
     */
    fun generateShortId(): String = generateId().substring(0, 8)

    /**
     * Calculate MD5 hash of a string.
     * @param input String to hash
     * @return MD5 hash string
     */
    fun md5(input: String): String {
        val md = MessageDigest.getInstance("MD5")
        val digest = md.digest(input.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }

    /**
     * Check if string is a valid email format.
     * @param email Email to validate
     * @return true if valid
     */
    fun isValidEmail(email: String): Boolean {
        val emailRegex = "^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$"
        return email.matches(Regex(emailRegex))
    }

    /**
     * Truncate string to specified length with ellipsis.
     * @param maxLength Maximum length
     * @return Truncated string
     */
    fun String.truncate(maxLength: Int): String {
        return if (this.length > maxLength) {
            this.substring(0, maxLength - 3) + "..."
        } else {
            this
        }
    }

    /**
     * Convert string to snake_case.
     * @return snake_case string
     */
    fun String.toSnakeCase(): String {
        return this.replace(Regex("([a-z])([A-Z]+)"), "$1_$2")
            .replace(Regex("\\s+"), "_")
            .lowercase()
    }

    /**
     * Convert string to kebab-case.
     * @return kebab-case string
     */
    fun String.toKebabCase(): String {
        return this.toSnakeCase().replace("_", "-")
    }

    /**
     * Count words in a string.
     * @return Word count
     */
    fun String.wordCount(): Int {
        return this.trim().split(Regex("\\s+")).size
    }

    /**
     * Reverse a string.
     * @return Reversed string
     */
    fun String.reverse(): String = this.reversed()

    /**
     * Check if string contains only digits.
     * @return true if only digits
     */
    fun String.isDigitsOnly(): Boolean = this.all { it.isDigit() }

    /**
     * Remove all whitespace from string.
     * @return String without whitespace
     */
    fun String.removeWhitespace(): String = this.replace(Regex("\\s+"), "")

    /**
     * Capitalize first letter of each word.
     * @return Title case string
     */
    fun String.toTitleCase(): String {
        return this.split(" ")
            .joinToString(" ") { word ->
                word.lowercase().replaceFirstChar { it.uppercase() }
            }
    }
}

/**
 * String builder utility with DSL support.
 */
class StringBuilderScope {
    private val builder = StringBuilder()

    /**
     * Append text with newline.
     */
    fun line(text: String = "") {
        builder.appendLine(text)
    }

    /**
     * Append text without newline.
     */
    fun append(text: String) {
        builder.append(text)
    }

    /**
     * Add a section header.
     */
    fun header(text: String) {
        builder.appendLine()
        builder.appendLine("=".repeat(text.length))
        builder.appendLine(text)
        builder.appendLine("=".repeat(text.length))
        builder.appendLine()
    }

    /**
     * Add a bullet point.
     */
    fun bullet(text: String) {
        builder.appendLine("• $text")
    }

    /**
     * Build the final string.
     */
    fun build(): String = builder.toString()
}

/**
 * Build a string using DSL syntax.
 * @param block DSL configuration
 * @return Built string
 */
inline fun buildStringBlock(block: StringBuilderScope.() -> Unit): String {
    return StringBuilderScope().apply(block).build()
}
