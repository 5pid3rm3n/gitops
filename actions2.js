/**
 * Swagger to GitHub Actions Converter
 * Converts OpenAPI/Swagger specifications to GitHub Actions workflows
 * Each API endpoint becomes a separate workflow with appropriate inputs
 * 
 * @requires fs - File system operations
 * @requires path - Path manipulation
 * @requires js-yaml - YAML parser/serializer
 * @requires prettier - Code formatter
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const prettier = require('prettier');

/**
 * Resolves schema references and handles array types in OpenAPI/Swagger specs
 * @param {Object} schema - Schema object that might contain references
 * @param {Object} components - Components section from OpenAPI spec
 * @returns {Object} Resolved schema object
 */
function resolveSchemaRef(schema, components = {}) {
  if (!schema) return {};
  
  // Handle $ref type references (e.g., "#/components/schemas/User")
  if (schema.$ref) {
    try {
      // Split reference path and navigate through components
      const refPath = schema.$ref.replace('#/', '').split('/');
      let resolved = components;
      for (const part of refPath) {
        resolved = resolved?.[part];
        if (!resolved) {
          console.warn(`Warning: Could not resolve reference ${schema.$ref}`);
          return {};
        }
      }
      return resolved;
    } catch (error) {
      console.warn(`Warning: Error resolving reference: ${error.message}`);
      return {};
    }
  }

  // Handle array type schemas with nested items
  if (schema.type === 'array' && schema.items) {
    const resolvedItems = resolveSchemaRef(schema.items, components);
    return {
      type: 'array',
      items: resolvedItems,
      properties: resolvedItems.properties || {}
    };
  }

  return schema;
}

/**
 * Extracts properties from request body schema
 * @param {Object} requestBody - Request body object from OpenAPI spec
 * @param {Object} components - Components containing schema definitions
 * @returns {Object} Properties and required fields
 */
function extractSchemaProperties(requestBody, components) {
  // Check for valid request body schema
  if (!requestBody?.content?.['application/json']?.schema) {
    return { properties: {}, required: [] };
  }

  const schema = resolveSchemaRef(requestBody.content['application/json'].schema, components);
  const required = schema.required || [];

  // Handle different schema types
  if (schema.type === 'array' && schema.items?.oneOf) {
    return extractArrayItemProperties(schema);
  }

  if (schema.oneOf) {
    return processOneOfSchemas(schema.oneOf);
  }

  // Process regular object properties
  if (schema.properties) {
    return {
      properties: Object.entries(schema.properties).reduce((acc, [key, prop]) => {
        // Add enum values to description if present
        const enumValues = prop.enum ? ` (${prop.enum.join(', ')})` : '';
        acc[key] = {
          ...prop,
          description: `${prop.description || key}${enumValues}`,
          required: required.includes(key)
        };
        return acc;
      }, {}),
      required
    };
  }

  return { properties: {}, required: [] };
}

/**
 * Extracts properties from array items with oneOf schemas
 * @param {Object} schema - Array schema with oneOf variants
 * @returns {Object} Combined properties and required fields
 */
function extractArrayItemProperties(schema) {
  const allProperties = {};
  const allRequired = new Set();

  schema.items.oneOf.forEach(variant => {
    if (variant.type === 'object') {
      const { properties, required } = extractNestedProperties(variant);
      Object.entries(properties).forEach(([key, value]) => {
        allProperties[key] = value;
      });
      required.forEach(req => allRequired.add(req));
    }
  });

  return {
    properties: allProperties,
    required: Array.from(allRequired)
  };
}

/**
 * Extracts properties from nested object structures
 * @param {Object} schema - Object schema with nested properties
 * @param {String} prefix - Prefix for nested property names
 * @returns {Object} Flattened properties and required fields
 */
function extractNestedProperties(schema, prefix = '') {
  let properties = {};
  let required = [];

  if (schema.type === 'object' && schema.properties) {
    Object.entries(schema.properties).forEach(([key, prop]) => {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      
      // Handle nested objects recursively
      if (prop.type === 'object' && prop.properties) {
        const nested = extractNestedProperties(prop, fullKey);
        properties = { ...properties, ...nested.properties };
        required = [...required, ...nested.required.map(r => `${fullKey}.${r}`)];
      } else {
        properties[fullKey] = prop;
        if (schema.required?.includes(key)) {
          required.push(fullKey);
        }
      }
    });
  }

  return { properties, required };
}

/**
 * Processes oneOf schemas and merges their properties
 * @param {Array} oneOfSchemas - Array of possible schema variants
 * @returns {Object} Merged properties and required fields
 */
function processOneOfSchemas(oneOfSchemas) {
  const allProperties = {};
  const allRequired = new Set();

  oneOfSchemas.forEach(schema => {
    if (schema.properties) {
      Object.entries(schema.properties).forEach(([key, value]) => {
        allProperties[key] = value;
      });
    }
    if (schema.required) {
      schema.required.forEach(field => allRequired.add(field));
    }
  });

  return {
    properties: allProperties,
    required: Array.from(allRequired)
  };
}

/**
 * Converts OpenAPI/Swagger types to GitHub Actions input types
 * @param {String} swaggerType - OpenAPI type
 * @returns {String} GitHub Actions input type
 */
function convertSwaggerTypeToWorkflowType(swaggerType) {
  const typeMap = {
    'string': 'string',
    'integer': 'number',
    'number': 'number',
    'boolean': 'boolean',
    'array': 'string',  // Arrays are passed as JSON strings
    'object': 'string'  // Objects are passed as JSON strings
  };
  return typeMap[swaggerType] || 'string';
}

/**
 * Generates GitHub Actions inputs from schema properties
 * @param {Object} properties - Schema properties
 * @param {Array} required - Required property names
 * @param {Object} components - OpenAPI components
 * @returns {String} Formatted inputs section
 */
async function generateInputsFromProperties(properties = {}, required = [], components = {}) {
  if (!properties || typeof properties !== 'object') {
    return '';
  }

  return Object.entries(properties).map(([name, schema]) => {
    const isRequired = Array.isArray(required) && required.includes(name);
    const description = schema.description || 
                       (schema.enum ? `${name} (${schema.enum.join(', ')})` : name);
    
    return `      ${name}:
        description: '${description}'
        required: ${isRequired}
        type: ${convertSwaggerTypeToWorkflowType(schema.type)}`;
  }).join('\n');
}

/**
 * Replaces path parameters with GitHub Actions input references
 * @param {String} pathUrl - URL pattern with parameters
 * @returns {String} URL with replaced parameters
 */
function replacePathParameters(pathUrl) {
  return pathUrl.replace(/{([^}]+)}/g, (match, param) => {
    return `\${{ inputs.${param} }}`;
  });
}

/**
 * Generates complete GitHub Actions workflow content
 * @param {String} operationId - Unique operation identifier
 * @param {String} method - HTTP method
 * @param {String} pathUrl - API endpoint path
 * @param {Object} operation - Operation object from OpenAPI spec
 * @param {Object} swagger - Complete OpenAPI specification
 * @returns {String} Complete workflow file content
 */
async function generateWorkflow(operationId, method, pathUrl, operation, swagger) {
  let inputsContent = '';
  
  // Process URL parameters
  const parameters = operation.parameters || [];
  const parameterInputs = parameters.map(param => {
    const resolvedParam = resolveSchemaRef(param.schema, swagger.components);
    return `      ${param.name}:
        description: '${param.description || param.name}'
        required: ${param.required || false}
        type: ${convertSwaggerTypeToWorkflowType(resolvedParam.type)}`;
  });

  // Process request body if present
  if (operation.requestBody) {
    const { properties, required } = extractSchemaProperties(operation.requestBody, swagger.components);
    const bodyInputs = await generateInputsFromProperties(properties, required, swagger.components);
    if (bodyInputs) {
      inputsContent = [parameterInputs.join('\n'), bodyInputs].filter(Boolean).join('\n');
    }
  } else {
    inputsContent = parameterInputs.join('\n');
  }

  // Replace path parameters with input references
  const formattedPath = replacePathParameters(pathUrl);

  // Generate complete workflow YAML
  return `
name: ${operationId}

on:
  workflow_dispatch:
    inputs:
${inputsContent}

jobs:
  api-call:
    runs-on: ubuntu-latest
    steps:
      - name: Make API Request
        id: api-request
        uses: fjogeleit/http-request-action@v1
        with:
          url: \${{ secrets.API_BASE_URL }}${formattedPath}
          method: ${method.toUpperCase()}
          customHeaders: '{"Content-Type": "application/json"}'
          bearerToken: \${{ secrets.API_TOKEN }}
          data: \${{ toJSON(inputs) }}
      
      - name: Response
        run: echo \${{ toJSON(steps.api-request.outputs.response) }} | jq .
  `;
}

/**
 * Main function to convert Swagger/OpenAPI spec to GitHub Actions
 * @param {String} swaggerPath - Path to OpenAPI specification file
 */
async function convertSwaggerToActions(swaggerPath) {
  try {
    // Read and parse Swagger file
    const swaggerContent = fs.readFileSync(swaggerPath, 'utf8');
    const swagger = yaml.load(swaggerContent) || {};
    
    if (!swagger.paths) {
      throw new Error('No paths found in Swagger specification');
    }

    // Create workflows directory
    const workflowsDir = path.join(process.cwd(), '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });

    // Process each API endpoint
    for (const [pathUrl, methods] of Object.entries(swagger.paths)) {
      for (const [method, operation] of Object.entries(methods || {})) {
        if (!operation) continue;

        const operationId = operation.operationId || `${method}-${pathUrl.replace(/\//g, '-')}`;
        
        // Generate and format workflow file
        const workflowContent = await generateWorkflow(operationId, method, pathUrl, operation, swagger);
        const formattedContent = await prettier.format(workflowContent, { parser: 'yaml' });
        
        // Save workflow file
        const workflowPath = path.join(workflowsDir, `${operationId}.yml`);
        fs.writeFileSync(workflowPath, formattedContent);
      }
    }
  } catch (error) {
    console.error(`Error converting Swagger to Actions: ${error.message}`);
    throw error;
  }
}

// Script entry point
const swaggerPath = process.argv[2] || 'swagger.yaml';
convertSwaggerToActions(swaggerPath).catch(console.error);