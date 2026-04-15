package com.example.utils

import java.util.regex.Pattern

/**
 * Validation utilities for common data types.
 *
 * This object provides validation functions for emails, phone numbers,
 * URLs, and other common formats.
 */
object ValidationUtils {

    private val EMAIL_PATTERN = Pattern.compile(
        "^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$"
    )

    private val PHONE_PATTERN = Pattern.compile(
        "^\\+?[1-9]\\d{1,14}$"
    )

    private val URL_PATTERN = Pattern.compile(
        "^(https?|ftp)://[^\\s/$.?#].[^\\s]*$",
        Pattern.CASE_INSENSITIVE
    )

    /**
     * Validate email address format.
     * @param email Email to validate
     * @return true if valid
     */
    fun isValidEmail(email: String): Boolean {
        return email.isNotBlank() && EMAIL_PATTERN.matcher(email).matches()
    }

    /**
     * Validate phone number format (E.164).
     * @param phone Phone number to validate
     * @return true if valid
     */
    fun isValidPhone(phone: String): Boolean {
        val cleaned = phone.replace(Regex("[\\s\\-()]"), "")
        return PHONE_PATTERN.matcher(cleaned).matches()
    }

    /**
     * Validate URL format.
     * @param url URL to validate
     * @return true if valid
     */
    fun isValidUrl(url: String): Boolean {
        return URL_PATTERN.matcher(url).matches()
    }

    /**
     * Validate age is within reasonable range.
     * @param age Age to validate
     * @param min Minimum age (default 0)
     * @param max Maximum age (default 150)
     * @return true if valid
     */
    fun isValidAge(age: Int, min: Int = 0, max: Int = 150): Boolean {
        return age in min..max
    }

    /**
     * Validate password strength.
     * @param password Password to validate
     * @param minLength Minimum length (default 8)
     * @return true if strong enough
     */
    fun isValidPassword(password: String, minLength: Int = 8): Boolean {
        if (password.length < minLength) return false

        val hasUpper = password.any { it.isUpperCase() }
        val hasLower = password.any { it.isLowerCase() }
        val hasDigit = password.any { it.isDigit() }
        val hasSpecial = password.any { !it.isLetterOrDigit() }

        return hasUpper && hasLower && hasDigit && hasSpecial
    }

    /**
     * Validate string is not blank and within length limits.
     * @param value String to validate
     * @param minLength Minimum length
     * @param maxLength Maximum length
     * @return true if valid
     */
    fun isValidLength(value: String, minLength: Int = 1, maxLength: Int = 255): Boolean {
        return value.length in minLength..maxLength
    }

    /**
     * Validate credit card number using Luhn algorithm.
     * @param cardNumber Card number to validate
     * @return true if valid
     */
    fun isValidCreditCard(cardNumber: String): Boolean {
        val cleaned = cardNumber.replace(Regex("\\D"), "")
        if (cleaned.length < 13 || cleaned.length > 19) return false

        var sum = 0
        var alternate = false
        for (i in cleaned.length - 1 downTo 0) {
            var n = cleaned[i].digitToInt()
            if (alternate) {
                n *= 2
                if (n > 9) n -= 9
            }
            sum += n
            alternate = !alternate
        }
        return sum % 10 == 0
    }
}

/**
 * Result type for validation operations.
 */
sealed class ValidationResult {
    /**
     * Validation passed.
     */
    data object Valid : ValidationResult()

    /**
     * Validation failed with errors.
     */
    data class Invalid(val errors: List<String>) : ValidationResult() {
        constructor(error: String) : this(listOf(error))
    }
}

/**
 * Validator class for complex validation scenarios.
 */
class Validator<T>(private val value: T) {
    private val errors = mutableListOf<String>()

    /**
     * Add validation rule.
     * @param condition Condition to check
     * @param errorMessage Error message if condition fails
     * @return this for chaining
     */
    fun validate(condition: (T) -> Boolean, errorMessage: String): Validator<T> {
        if (!condition(value)) {
            errors.add(errorMessage)
        }
        return this
    }

    /**
     * Check if email is valid.
     * @param selector Function to extract email from value
     * @param fieldName Field name for error message
     * @return this for chaining
     */
    fun isEmail(selector: (T) -> String, fieldName: String = "email"): Validator<T> {
        return validate(
            { ValidationUtils.isValidEmail(selector(it)) },
            "$fieldName must be a valid email address"
        )
    }

    /**
     * Check minimum length.
     * @param selector Function to extract string from value
     * @param minLength Minimum required length
     * @param fieldName Field name for error message
     * @return this for chaining
     */
    fun minLength(selector: (T) -> String, minLength: Int, fieldName: String): Validator<T> {
        return validate(
            { selector(it).length >= minLength },
            "$fieldName must be at least $minLength characters"
        )
    }

    /**
     * Get validation result.
     * @return ValidationResult
     */
    fun result(): ValidationResult {
        return if (errors.isEmpty()) {
            ValidationResult.Valid
        } else {
            ValidationResult.Invalid(errors)
        }
    }

    /**
     * Check if validation passed.
     * @return true if valid
     */
    fun isValid(): Boolean = errors.isEmpty()
}

/**
 * Create a validator for a value.
 * @param value Value to validate
 * @return Validator instance
 */
fun <T> validate(value: T): Validator<T> = Validator(value)

/**
 * Inline validation using DSL.
 * @param block Validation configuration
 * @return ValidationResult
 */
inline fun validation(block: MutableList<String>.() -> Unit): ValidationResult {
    val errors = mutableListOf<String>()
    errors.block()
    return if (errors.isEmpty()) ValidationResult.Valid else ValidationResult.Invalid(errors)
}
