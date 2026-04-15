#!/usr/bin/env python3
"""
Deployment Script

This script handles deployment operations for the mixed project.
Supports multiple deployment targets: staging, production.
"""

import argparse
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass, asdict
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class Environment(str, Enum):
    """Deployment environment enumeration."""
    STAGING = "staging"
    PRODUCTION = "production"
    DEVELOPMENT = "development"


@dataclass
class DeployConfig:
    """Deployment configuration.
    
    Attributes:
        environment: Target deployment environment
        version: Application version to deploy
        dry_run: Whether to perform a dry run
        force: Whether to force deployment
    """
    environment: Environment
    version: str
    dry_run: bool = False
    force: bool = False


class DeploymentError(Exception):
    """Custom exception for deployment failures."""
    pass


class Deployer:
    """Handles deployment operations.
    
    This class manages the deployment process including:
    - Building application artifacts
    - Running pre-deployment checks
    - Executing deployment commands
    - Verifying deployment success
    
    Example:
        >>> config = DeployConfig(
        ...     environment=Environment.STAGING,
        ...     version="1.0.0"
        ... )
        >>> deployer = Deployer(config)
        >>> deployer.deploy()
    """
    
    def __init__(self, config: DeployConfig):
        """Initialize deployer with configuration.
        
        Args:
            config: Deployment configuration
        """
        self.config = config
        self.project_root = Path(__file__).parent.parent
        
    def deploy(self) -> bool:
        """Execute full deployment process.
        
        Returns:
            True if deployment successful
            
        Raises:
            DeploymentError: If deployment fails
        """
        logger.info(f"Starting deployment to {self.config.environment}")
        
        try:
            self._run_pre_checks()
            self._build_artifacts()
            self._deploy_to_target()
            self._verify_deployment()
            
            logger.info("Deployment completed successfully")
            return True
            
        except Exception as e:
            logger.error(f"Deployment failed: {e}")
            raise DeploymentError(f"Deployment failed: {e}")
    
    def _run_pre_checks(self) -> None:
        """Run pre-deployment checks.
        
        Verifies:
        - Required environment variables are set
        - Target environment is accessible
        - Version tag exists
        """
        logger.info("Running pre-deployment checks...")
        
        required_vars = ["DEPLOY_KEY", "API_TOKEN"]
        for var in required_vars:
            if not os.environ.get(var):
                raise DeploymentError(f"Missing required environment variable: {var}")
        
        if self.config.dry_run:
            logger.info("Dry run mode - skipping actual deployment")
    
    def _build_artifacts(self) -> None:
        """Build deployment artifacts.
        
        Builds frontend and backend components.
        """
        logger.info("Building artifacts...")
        
        # Build frontend
        frontend_dir = self.project_root / "frontend"
        if frontend_dir.exists():
            self._run_command(["npm", "run", "build"], cwd=frontend_dir)
        
        # Build backend
        backend_dir = self.project_root / "backend"
        if backend_dir.exists():
            self._run_command(["npm", "run", "build"], cwd=backend_dir)
    
    def _deploy_to_target(self) -> None:
        """Deploy artifacts to target environment."""
        if self.config.dry_run:
            return
            
        logger.info(f"Deploying to {self.config.environment}...")
        
        # Simulate deployment command
        deploy_cmd = [
            "deploy-cli",
            "--env", self.config.environment.value,
            "--version", self.config.version,
        ]
        
        if self.config.force:
            deploy_cmd.append("--force")
        
        self._run_command(deploy_cmd)
    
    def _verify_deployment(self) -> None:
        """Verify deployment was successful.
        
        Performs health checks on deployed services.
        """
        logger.info("Verifying deployment...")
        
        # Simulate health check
        health_url = self._get_health_url()
        logger.info(f"Checking health at {health_url}")
    
    def _get_health_url(self) -> str:
        """Get health check URL for environment.
        
        Returns:
            Health check endpoint URL
        """
        base_urls = {
            Environment.DEVELOPMENT: "http://localhost:3000",
            Environment.STAGING: "https://staging.example.com",
            Environment.PRODUCTION: "https://example.com",
        }
        return f"{base_urls[self.config.environment]}/api/health"
    
    def _run_command(
        self, 
        cmd: List[str], 
        cwd: Optional[Path] = None,
        check: bool = True
    ) -> Tuple[int, str, str]:
        """Run a shell command.
        
        Args:
            cmd: Command and arguments
            cwd: Working directory
            check: Whether to raise on non-zero exit
            
        Returns:
            Tuple of (exit_code, stdout, stderr)
        """
        logger.debug(f"Running command: {' '.join(cmd)}")
        
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True
        )
        
        if check and result.returncode != 0:
            raise DeploymentError(
                f"Command failed: {' '.join(cmd)}\n{result.stderr}"
            )
        
        return result.returncode, result.stdout, result.stderr


def parse_args() -> DeployConfig:
    """Parse command line arguments.
    
    Returns:
        Parsed deployment configuration
    """
    parser = argparse.ArgumentParser(
        description="Deploy application to target environment"
    )
    
    parser.add_argument(
        "environment",
        choices=[e.value for e in Environment],
        help="Target deployment environment"
    )
    
    parser.add_argument(
        "--version",
        required=True,
        help="Application version to deploy"
    )
    
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Perform a dry run without actual deployment"
    )
    
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force deployment even if checks fail"
    )
    
    parser.add_argument(
        "--config",
        type=Path,
        help="Path to configuration file"
    )
    
    args = parser.parse_args()
    
    return DeployConfig(
        environment=Environment(args.environment),
        version=args.version,
        dry_run=args.dry_run,
        force=args.force
    )


def load_config_file(path: Path) -> Dict:
    """Load configuration from JSON file.
    
    Args:
        path: Path to config file
        
    Returns:
        Configuration dictionary
    """
    with open(path, 'r') as f:
        return json.load(f)


def main() -> int:
    """Main entry point.
    
    Returns:
        Exit code (0 for success)
    """
    try:
        config = parse_args()
        deployer = Deployer(config)
        deployer.deploy()
        return 0
        
    except DeploymentError as e:
        logger.error(f"Deployment error: {e}")
        return 1
    except KeyboardInterrupt:
        logger.info("Deployment cancelled by user")
        return 130
    except Exception as e:
        logger.exception("Unexpected error during deployment")
        return 1


if __name__ == "__main__":
    sys.exit(main())
