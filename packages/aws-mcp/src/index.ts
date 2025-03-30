import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
const server = new Server({
  name: "@rutamu/aws-mcp",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {
      list: {},
    },
  }
});

const FindEc2InstancesInputSchema = z.object({
  status: z.enum(["running", "stopped"]).default("running"),
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "find_ec2_instances",
        description: "List AWS EC2 instances",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["running", "stopped"],
              default: "running",
            }
          },
        }
      }
    ]
  }
})





server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { params } = request;
  switch (params.name) {
    case "find_ec2_instances": {
      const args = FindEc2InstancesInputSchema.parse(params.arguments);
      const instances = await findEc2Instances(args);
      if (instances.length === 0) {
        console.log(`${args.status}状態のEC2インスタンスはありません。`);
      } else {
        console.log(`${instances.length}件の${args.status}状態のEC2インスタンスが見つかりました：`);
        console.table(instances);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(instances, null, 2),
          }
        ]
      };
    }
    default:
      throw new Error(`Tool ${params.name} not found`) ;
  }
})


async function findEc2Instances(args: { status: "running" | "stopped"; }) {
  const client = new EC2Client();
  const command = new DescribeInstancesCommand({
    Filters: [
      {
        Name: "instance-state-name",
        Values: [args.status],
      },
    ],
  });
  const response = await client.send(command);
  console.log("response", response);

  const instances = response.Reservations?.flatMap(reservation => reservation.Instances?.map(instance => ({
    id: instance.InstanceId,
    type: "ec2",
    name: instance.Tags?.find(tag => tag.Key === "Name")?.Value ?? "Unnamed Instance",
  })) ?? []
  ) ?? [];
  return instances;
}

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Server '@rutamu/aws-mcp' is running on stdio");
  console.error("used profile: ", process.env.AWS_PROFILE);
}

runServer().catch((error) => {
  console.error("Error starting server:", error);
  process.exit(1);
})