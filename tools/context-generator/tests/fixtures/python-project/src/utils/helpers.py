"""
Helper utility functions.

This module provides various utility functions for string manipulation,
data validation, and JSON parsing.
"""

import json
import re
from typing import Any, Dict, List, Optional, TypeVar, Callable
from functools import wraps

T = TypeVar('T')


def format_string(value: str, trim: bool = True, lower: bool = False) -> str:
    """Format a string by trimming whitespace and optionally lowercasing.
    
    Args:
        value: Input string to format.
        trim: Whether to trim whitespace. Defaults to True.
        lower: Whether to convert to lowercase. Defaults to False.
        
    Returns:
        Formatted string.
        
    Example:
        >>> format_string("  HELLO  ")
        'HELLO'
        >>> format_string("  HELLO  ", lower=True)
        'hello'
    """
    result = value
    if trim:
        result = result.strip()
    if lower:
        result = result.lower()
    return result


def validate_input(value: Any, min_length: int = 1, max_length: int = 1000) -> bool:
    """Validate that input meets length requirements.
    
    Args:
        value: Input value to validate.
        min_length: Minimum allowed length.
        max_length: Maximum allowed length.
        
    Returns:
        True if valid, False otherwise.
    """
    if value is None:
        return False
    
    try:
        length = len(value)
        return min_length <= length <= max_length
    except TypeError:
        return False


def parse_json(data: str) -> Dict[str, Any]:
    """Parse JSON string to dictionary.
    
    Args:
        data: JSON string to parse.
        
    Returns:
        Parsed dictionary.
        
    Raises:
        ValueError: If JSON is invalid.
    """
    try:
        result = json.loads(data)
        if not isinstance(result, dict):
            raise ValueError("JSON must be an object")
        return result
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON: {e}")


def extract_emails(text: str) -> List[str]:
    """Extract email addresses from text.
    
    Args:
        text: Text to search for emails.
        
    Returns:
        List of found email addresses.
    """
    pattern = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
    return re.findall(pattern, text)


def chunk_list(items: List[T], chunk_size: int) -> List[List[T]]:
    """Split a list into chunks of specified size.
    
    Args:
        items: List to chunk.
        chunk_size: Size of each chunk.
        
    Returns:
        List of chunks.
        
    Raises:
        ValueError: If chunk_size is less than 1.
    """
    if chunk_size < 1:
        raise ValueError("chunk_size must be at least 1")
    
    return [items[i:i + chunk_size] for i in range(0, len(items), chunk_size)]


def retry(max_attempts: int = 3, delay: float = 1.0) -> Callable:
    """Decorator to retry a function on failure.
    
    Args:
        max_attempts: Maximum number of retry attempts.
        delay: Delay between retries in seconds.
        
    Returns:
        Decorator function.
    """
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> T:
            import time
            last_error: Optional[Exception] = None
            
            for attempt in range(max_attempts):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_error = e
                    if attempt < max_attempts - 1:
                        time.sleep(delay)
            
            raise last_error or RuntimeError("All retry attempts failed")
        
        return wrapper
    return decorator


class ValidationError(Exception):
    """Custom validation error exception."""
    
    def __init__(self, message: str, field: Optional[str] = None):
        super().__init__(message)
        self.field = field
        self.message = message


def validate_email(email: str) -> bool:
    """Validate email address format.
    
    Args:
        email: Email address to validate.
        
    Returns:
        True if valid, False otherwise.
    """
    if not email or '@' not in email:
        return False
    
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email))


# Type aliases
JsonDict = Dict[str, Any]
StringList = List[str]
OptionalInt = Optional[int]
