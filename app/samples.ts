const ORDERS_API = {
  swagger: "2.0",
  info: {
    title: "Orders API",
    description: "Create and track customer orders.",
    version: "1.4.0",
  },
  host: "api.example.com",
  basePath: "/v1",
  schemes: ["https"],
  consumes: ["application/json"],
  produces: ["application/json"],
  paths: {
    "/orders": {
      get: {
        summary: "List orders",
        operationId: "listOrders",
        parameters: [
          {
            name: "limit",
            in: "query",
            type: "integer",
            format: "int32",
            default: 20,
          },
        ],
        responses: {
          "200": {
            description: "A list of orders",
            schema: {
              type: "array",
              items: { $ref: "#/definitions/Order" },
            },
          },
        },
      },
      post: {
        summary: "Create an order",
        operationId: "createOrder",
        parameters: [
          {
            name: "order",
            in: "body",
            required: true,
            schema: { $ref: "#/definitions/NewOrder" },
          },
        ],
        responses: {
          "201": {
            description: "Order created",
            schema: { $ref: "#/definitions/Order" },
          },
        },
      },
    },
  },
  definitions: {
    NewOrder: {
      type: "object",
      required: ["productId", "quantity"],
      properties: {
        productId: { type: "string" },
        quantity: { type: "integer", minimum: 1 },
      },
    },
    Order: {
      allOf: [
        { $ref: "#/definitions/NewOrder" },
        {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["pending", "shipped"] },
          },
        },
      ],
    },
  },
};

const PETSTORE_YAML = `swagger: "2.0"
info:
  title: Petstore
  description: A small pet store with uploads, auth and form data.
  version: "1.0.0"
host: petstore.example.com
basePath: /v2
schemes:
  - https
  - http
tags:
  - name: pet
    description: Everything about your pets
securityDefinitions:
  petstore_auth:
    type: oauth2
    flow: implicit
    authorizationUrl: https://petstore.example.com/oauth/authorize
    scopes:
      write:pets: modify pets in your account
      read:pets: read your pets
  api_key:
    type: apiKey
    name: api_key
    in: header
paths:
  /pet:
    post:
      tags: [pet]
      summary: Add a new pet to the store
      operationId: addPet
      consumes: [application/json, application/xml]
      produces: [application/json]
      parameters:
        - in: body
          name: body
          required: true
          schema:
            $ref: "#/definitions/Pet"
      responses:
        "405":
          description: Invalid input
      security:
        - petstore_auth: [write:pets, read:pets]
  /pet/findByStatus:
    get:
      tags: [pet]
      summary: Finds pets by status
      operationId: findPetsByStatus
      produces: [application/json]
      parameters:
        - name: status
          in: query
          required: true
          type: array
          items:
            type: string
            enum: [available, pending, sold]
          collectionFormat: multi
      responses:
        "200":
          description: successful operation
          schema:
            type: array
            items:
              $ref: "#/definitions/Pet"
  /pet/{petId}/uploadImage:
    post:
      tags: [pet]
      summary: Uploads an image
      operationId: uploadFile
      consumes: [multipart/form-data]
      produces: [application/json]
      parameters:
        - name: petId
          in: path
          required: true
          type: integer
          format: int64
        - name: file
          in: formData
          description: file to upload
          type: file
      responses:
        "200":
          description: successful operation
      security:
        - api_key: []
definitions:
  Pet:
    type: object
    required: [name]
    properties:
      id:
        type: integer
        format: int64
      name:
        type: string
        example: doggie
      status:
        type: string
        description: pet status in the store
        enum: [available, pending, sold]
`;

export type Sample = { id: string; label: string; source: string };

export const SAMPLES: Sample[] = [
  {
    id: "orders",
    label: "Orders API · JSON",
    source: JSON.stringify(ORDERS_API, null, 2),
  },
  { id: "petstore", label: "Petstore · YAML", source: PETSTORE_YAML },
];
