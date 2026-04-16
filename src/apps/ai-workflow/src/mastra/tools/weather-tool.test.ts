import { describe, it, expect } from 'vitest';
import { weatherTool } from './weather-tool.js';

describe('weatherTool', () => {
  it('should have correct tool configuration', () => {
    expect(weatherTool.id).toBe('get-weather');
    expect(weatherTool.description).toBe('Get current weather for a location');
  });

  it('should validate correct input schema', () => {
    const validInput = { location: 'New York' };
    const result = weatherTool.inputSchema?.safeParse(validInput);
    expect(result?.success).toBe(true);
  });

  it('should reject invalid input schema', () => {
    const invalidInput = { location: 123 };
    const result = weatherTool.inputSchema?.safeParse(invalidInput);
    expect(result?.success).toBe(false);
  });

  it('should require location field', () => {
    const emptyInput = {};
    const result = weatherTool.inputSchema?.safeParse(emptyInput);
    expect(result?.success).toBe(false);
  });

  it('should have output schema defined', () => {
    expect(weatherTool.outputSchema).toBeDefined();
  });
});
