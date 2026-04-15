/**
 * Button component for React applications
 */

import React from 'react';

/**
 * Button size variants
 */
export type ButtonSize = 'small' | 'medium' | 'large';

/**
 * Button color variants
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger';

/**
 * Button component props
 */
export interface ButtonProps {
  /** Button text content */
  children: React.ReactNode;
  /** Button size variant */
  size?: ButtonSize;
  /** Button color variant */
  variant?: ButtonVariant;
  /** Disabled state */
  disabled?: boolean;
  /** Loading state */
  loading?: boolean;
  /** Click handler */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Button component
 * @param props - Button props
 * @returns React button element
 */
export function Button({
  children,
  size = 'medium',
  variant = 'primary',
  disabled = false,
  loading = false,
  onClick,
  className = '',
}: ButtonProps): React.ReactElement {
  const baseClasses = 'btn';
  const sizeClasses = `btn--${size}`;
  const variantClasses = `btn--${variant}`;
  
  const classes = [baseClasses, sizeClasses, variantClasses, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={classes}
      disabled={disabled || loading}
      onClick={onClick}
      type="button"
    >
      {loading ? <span className="btn__spinner" /> : children}
    </button>
  );
}

/**
 * Icon button component props
 */
export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  /** Icon element */
  icon: React.ReactNode;
  /** Accessible label */
  ariaLabel: string;
}

/**
 * Icon button component
 */
export function IconButton({
  icon,
  ariaLabel,
  size = 'medium',
  variant = 'primary',
  disabled = false,
  onClick,
  className = '',
}: IconButtonProps): React.ReactElement {
  return (
    <button
      className={`icon-btn icon-btn--${size} ${className}`}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      type="button"
    >
      {icon}
    </button>
  );
}

/**
 * Button group component props
 */
export interface ButtonGroupProps {
  /** Button children */
  children: React.ReactNode;
  /** Group orientation */
  orientation?: 'horizontal' | 'vertical';
  /** Spacing between buttons */
  spacing?: 'none' | 'small' | 'medium' | 'large';
}

/**
 * Button group component for grouping related buttons
 */
export function ButtonGroup({
  children,
  orientation = 'horizontal',
  spacing = 'small',
}: ButtonGroupProps): React.ReactElement {
  const classes = [
    'btn-group',
    `btn-group--${orientation}`,
    `btn-group--${spacing}`,
  ].join(' ');

  return <div className={classes}>{children}</div>;
}

export default Button;
