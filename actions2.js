const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const prettier = require('prettier');

function resolveSchemaRef(schema, components = {}) {
  if (!schema) return {};
  
  if (schema.$ref) {
    try {
      // Remove #/ prefix and split into parts
      const refPath = schema.$ref.replace('#/', '').split('/');
      let resolved = components;
      
      // Debug log
      console.log(`Resolving reference: ${schema.$ref}`);
      console.log('Available components:', Object.keys(components));
      
      for (const part of refPath) {
        resolved = resolved?.[part];
        if (!resolved) {
          console.warn(`Warning: Could not resolve reference ${schema.$ref} at part ${part}`);
          console.warn('Available paths:', Object.keys(resolved || {}));
          return {};
        }
      }
      
      // If resolved schema is an array type, preserve its structure
      if (resolved.type === 'array') {
        return {
          type: 'array',
          items: {
            type: resolved.items.type || 'object',
            properties: resolved.items.properties || {},
            required: resolved.items.required || []
          },
          description: resolved.description || 'Array of items'
        };
      }
      
      return resolved;
    } catch (error) {
      console.warn(`Warning: Error resolving reference: ${error.message}`);
      return {};
    }
  }

  // Handle direct array type schemas
  if (schema.type === 'array' && schema.items) {
    const resolvedItems = resolveSchemaRef(schema.items, components);
    return {
      type: 'array',
      items: resolvedItems,
      properties: resolvedItems.properties || {},
      required: resolvedItems.required || []
    };
  }

  return schema;
}
function extractSchemaProperties(requestBody, components) {
  if (!requestBody?.content?.['application/json']?.schema) {
    return { properties: {}, required: [] };
  }

  const schema = resolveSchemaRef(requestBody.content['application/json'].schema, components);

  if (schema.type === 'array') {
    return {
      properties: schema.items.properties || {},
      required: schema.items.required || []
    };
  }

  if (schema.oneOf) {
    return processOneOfSchemas(schema.oneOf);
  }

  return {
    properties: schema.properties || {},
    required: schema.required || []
  };
}

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

async function generateInputsFromProperties(properties = {}, required = [], components = {}) {
  if (!properties || typeof properties !== 'object') {
    return '';
  }

  return Object.entries(properties).map(([name, schema]) => {
    const resolvedSchema = resolveSchemaRef(schema, components) || {};
    const isRequired = Array.isArray(required) && required.includes(name);
    const description = resolvedSchema.description || 
                       (resolvedSchema.format ? `${name} (${resolvedSchema.format})` : name);
    
    return `      ${name}:
        description: '${description}'
        required: ${isRequired}
        type: ${convertSwaggerTypeToWorkflowType(resolvedSchema.type)}`;
  }).join('\n');
}

function convertSwaggerTypeToWorkflowType(swaggerType) {
  const typeMap = {
    'string': 'string',
    'integer': 'number',
    'number': 'number',
    'boolean': 'boolean',
    'array': 'string',
    'object': 'string'
  };
  return typeMap[swaggerType] || 'string';
}

async function generateWorkflow(operationId, method, pathUrl, operation, swagger) {
  let inputsContent = '';
  
  const parameters = operation.parameters || [];
  const parameterInputs = parameters.map(param => {
    const resolvedParam = resolveSchemaRef(param.schema, swagger.components);
    return `      ${param.name}:
        description: '${param.description || param.name}'
        required: ${param.required || false}
        type: ${convertSwaggerTypeToWorkflowType(resolvedParam.type)}`;
  });

  if (operation.requestBody) {
    const { properties, required } = extractSchemaProperties(operation.requestBody, swagger.components);
    const bodyInputs = await generateInputsFromProperties(properties, required, swagger.components);
    if (bodyInputs) {
      inputsContent = [parameterInputs.join('\n'), bodyInputs].filter(Boolean).join('\n');
    }
  } else {
    inputsContent = parameterInputs.join('\n');
  }

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
        uses: fjogeleit/http-request-action@v1
        with:
          url: \${{ secrets.API_BASE_URL }}${pathUrl}
          method: ${method.toUpperCase()}
          customHeaders: '{"Content-Type": "application/json"}'
          bearerToken: \${{ secrets.API_TOKEN }}
          data: \${{ toJSON(inputs) }}
  `;
}

async function convertSwaggerToActions(swaggerPath) {
  try {
    const swaggerContent = fs.readFileSync(swaggerPath, 'utf8');
    const swagger = yaml.load(swaggerContent) || {};
    
    if (!swagger.paths) {
      throw new Error('No paths found in Swagger specification');
    }

    const workflowsDir = path.join(process.cwd(), '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });

    for (const [pathUrl, methods] of Object.entries(swagger.paths)) {
      for (const [method, operation] of Object.entries(methods || {})) {
        if (!operation) continue;

        const operationId = operation.operationId || `${method}-${pathUrl.replace(/\//g, '-')}`;
        
        const workflowContent = await generateWorkflow(operationId, method, pathUrl, operation, swagger);
        const formattedContent = await prettier.format(workflowContent, { parser: 'yaml' });
        
        const workflowPath = path.join(workflowsDir, `${operationId}.yml`);
        fs.writeFileSync(workflowPath, formattedContent);
      }
    }
  } catch (error) {
    console.error(`Error converting Swagger to Actions: ${error.message}`);
    throw error;
  }
}

const swaggerPath = process.argv[2] || 'swagger.yaml';
convertSwaggerToActions(swaggerPath).catch(console.error);