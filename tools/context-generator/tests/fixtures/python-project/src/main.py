"""
Main application module.

This module contains the core application logic and entry points.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from dataclasses import dataclass, field

from .utils.helpers import format_string, validate_input

# Configure logging
logger = logging.getLogger(__name__)


@dataclass
class AppConfig:
    """Application configuration dataclass.
    
    Attributes:
        name: Application name
        debug: Debug mode flag
        max_workers: Maximum worker threads
        settings: Additional settings dictionary
    """
    name: str = "TestApp"
    debug: bool = False
    max_workers: int = 4
    settings: Dict[str, Any] = field(default_factory=dict)


class Application:
    """Main application class.
    
    This class handles the core application lifecycle and provides
    methods for managing application state.
    
    Example:
        >>> config = AppConfig(name="MyApp", debug=True)
        >>> app = Application(config)
        >>> await app.start()
    """
    
    def __init__(self, config: Optional[AppConfig] = None):
        """Initialize the application.
        
        Args:
            config: Application configuration. Uses defaults if not provided.
        """
        self.config = config or AppConfig()
        self._running = False
        self._start_time: Optional[datetime] = None
        self._workers: List[asyncio.Task] = []
    
    @property
    def is_running(self) -> bool:
        """Check if the application is running."""
        return self._running
    
    @property
    def uptime(self) -> float:
        """Get application uptime in seconds."""
        if self._start_time is None:
            return 0.0
        return (datetime.now() - self._start_time).total_seconds()
    
    async def start(self) -> None:
        """Start the application.
        
        Raises:
            RuntimeError: If application is already running.
        """
        if self._running:
            raise RuntimeError("Application is already running")
        
        self._running = True
        self._start_time = datetime.now()
        logger.info(f"Starting {self.config.name}...")
        
        # Initialize workers
        await self._init_workers()
    
    async def stop(self) -> None:
        """Stop the application gracefully."""
        if not self._running:
            return
        
        logger.info("Stopping application...")
        self._running = False
        
        # Cancel all workers
        for worker in self._workers:
            worker.cancel()
        
        self._workers.clear()
    
    async def _init_workers(self) -> None:
        """Initialize worker tasks."""
        for i in range(self.config.max_workers):
            task = asyncio.create_task(self._worker_loop(f"worker-{i}"))
            self._workers.append(task)
    
    async def _worker_loop(self, name: str) -> None:
        """Worker loop for background tasks.
        
        Args:
            name: Worker name identifier.
        """
        while self._running:
            try:
                await asyncio.sleep(1)
                logger.debug(f"{name} is active")
            except asyncio.CancelledError:
                logger.info(f"{name} cancelled")
                break
    
    def process_data(self, data: Union[str, List[str]]) -> Dict[str, Any]:
        """Process input data and return results.
        
        Args:
            data: Input data to process. Can be a string or list of strings.
            
        Returns:
            Dictionary containing processed results.
            
        Raises:
            ValueError: If data format is invalid.
        """
        if isinstance(data, str):
            return {"type": "single", "value": format_string(data)}
        elif isinstance(data, list):
            return {"type": "batch", "values": [format_string(d) for d in data]}
        else:
            raise ValueError("Invalid data format")


def create_app(config_dict: Optional[Dict[str, Any]] = None) -> Application:
    """Application factory function.
    
    Creates and configures an Application instance from a dictionary.
    
    Args:
        config_dict: Configuration dictionary.
        
    Returns:
        Configured Application instance.
    """
    if config_dict is None:
        config_dict = {}
    
    config = AppConfig(
        name=config_dict.get("name", "TestApp"),
        debug=config_dict.get("debug", False),
        max_workers=config_dict.get("max_workers", 4),
        settings=config_dict.get("settings", {})
    )
    
    return Application(config)


# Module-level constants
DEFAULT_TIMEOUT: float = 30.0
MAX_RETRIES: int = 3
SUPPORTED_FORMATS: List[str] = ["json", "yaml", "xml"]


async def main() -> int:
    """Main entry point.
    
    Returns:
        Exit code (0 for success, non-zero for errors).
    """
    app = create_app({"name": "CLIApp", "debug": True})
    
    try:
        await app.start()
        await asyncio.sleep(5)  # Run for 5 seconds
        await app.stop()
        return 0
    except Exception as e:
        logger.error(f"Application error: {e}")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    exit(exit_code)
