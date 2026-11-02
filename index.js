import { tool } from "@langchain/core/tools";
import { z } from "zod";
import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import express from "express";
import cors from "cors";

/**
 * Searches GoHighLevel contacts by name and returns formatted results.
 */
const searchContacts = tool(
  async ({ name }) => {
    const lowercasedName = name.toLowerCase();
    const url = "https://services.leadconnectorhq.com/contacts/search";
    const apiKey = process.env.GHL_API_KEY;
    const locationId = process.env.GHL_LOCATION_ID;

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
    };

    const body = {
      locationId,
      pageLimit: 20,
      filters: [
        {
          field: "firstNameLowerCase",
          operator: "contains",
          value: lowercasedName,
        },
      ],
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const data = await response.json();
      const contacts = data.contacts || [];

      if (contacts.length === 0) {
        return "No contacts found matching that name.";
      }

      const formattedContacts = contacts.map((contact, index) => {
        const capitalizedFirstName = capitalize(
          contact.firstNameLowerCase || "",
        );
        const capitalizedLastName = capitalize(contact.lastNameLowerCase || "");
        const fullName = [capitalizedFirstName, capitalizedLastName]
          .filter(Boolean)
          .join(" ");
        const phone = contact.phone || "N/A";
        return `${index + 1}) ${fullName} (id: ${contact.id}, phone: ${phone})`;
      });

      return `Found ${contacts.length} contact(s): ${formattedContacts.join(" ")}`;
    } catch (error) {
      return `Error searching contacts: ${error.message}`;
    }
  },
  {
    name: "searchContacts",
    description:
      "Search for GoHighLevel contacts by name. Returns matching contacts with their IDs.",
    schema: z.object({
      name: z
        .string()
        .describe("The contact's first or last name to search for."),
    }),
  },
);

/**
 * Capitalizes the first letter of a given string.
 */
function capitalize(string) {
  if (!string) {
    return "";
  }
  return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * Fetches all pipelines and stages from GHL and returns lookup maps by ID.
 */
async function getPipelinesMap() {
  const url = `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${process.env.GHL_LOCATION_ID}`;
  const headers = {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
  };

  const response = await fetch(url, { method: "GET", headers });
  const data = await response.json();
  const pipelinesList = data.pipelines || [];

  const pipelines = {};
  const stages = {};
  const stageToPipeline = {};

  for (const pipeline of pipelinesList) {
    pipelines[pipeline.id] = pipeline.name;
    for (const stage of pipeline.stages || []) {
      stages[stage.id] = stage.name;
      stageToPipeline[stage.id] = pipeline.id;
    }
  }

  return { pipelines, stages, stageToPipeline };
}

/**
 * Retrieves opportunity/pipeline status for a given contact from GHL.
 */
const getOpportunityStatus = tool(
  async ({ contactId }) => {
    const apiKey = process.env.GHL_API_KEY;
    const locationId = process.env.GHL_LOCATION_ID;

    try {
      const { pipelines, stages } = await getPipelinesMap();

      const url = "https://services.leadconnectorhq.com/opportunities/search";
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      };

      const body = {
        locationId,
        limit: 20,
        page: 0,
        filters: [
          {
            field: "contact_id",
            operator: "eq",
            value: contactId,
          },
        ],
      };

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const data = await response.json();
      const opportunities = data.opportunities || [];

      if (opportunities.length === 0) {
        return "This contact has no active opportunities.";
      }

      const formatOpportunity = (opportunity) => {
        const contactName = opportunity.contact?.name || "Unknown";
        const opportunityName = opportunity.name || "Unnamed";
        const pipelineName =
          pipelines[opportunity.pipelineId] ||
          opportunity.pipelineId ||
          "Unknown";
        const stageName =
          stages[opportunity.pipelineStageId] ||
          opportunity.pipelineStageId ||
          "Unknown";
        return `${contactName}'s opportunity '${opportunityName}' is in pipeline '${pipelineName}', stage '${stageName}', status: ${opportunity.status}.`;
      };

      if (opportunities.length === 1) {
        return formatOpportunity(opportunities[0]);
      }

      const formattedList = opportunities
        .map(
          (opportunity, index) =>
            `${index + 1}) ${formatOpportunity(opportunity)}`,
        )
        .join(" ");

      return `${formattedList} This contact has multiple opportunities — please specify which one you mean.`;
    } catch (error) {
      return `Error retrieving opportunity status: ${error.message}`;
    }
  },
  {
    name: "getOpportunityStatus",
    description:
      "Get the pipeline status of all opportunities linked to a specific contact, using their contact ID.",
    schema: z.object({
      contactId: z
        .string()
        .describe(
          "The GoHighLevel contact ID to check opportunity status for.",
        ),
    }),
  },
);

/**
 * Lists all pipeline names and their stages available in the GHL account.
 */
const listPipelineStages = tool(
  async () => {
    try {
      const url = `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${process.env.GHL_LOCATION_ID}`;
      const headers = {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      };

      const response = await fetch(url, { method: "GET", headers });
      const data = await response.json();
      const pipelinesList = data.pipelines || [];

      const formatted = pipelinesList
        .map((pipeline) => {
          const stageNames = (pipeline.stages || [])
            .map((stage) => stage.name)
            .join(", ");
          return `${pipeline.name}: ${stageNames}`;
        })
        .join("\n");

      return formatted;
    } catch (error) {
      return `Error listing pipeline stages: ${error.message}`;
    }
  },
  {
    name: "listPipelineStages",
    description:
      "List all pipeline names and their stage names currently available in this GoHighLevel account. Useful for discovering exact stage names before searching by stage.",
    schema: z.object({}),
  },
);

async function fetchAllMatchingOpportunities(filters, locationId, apiKey) {
  const url = "https://services.leadconnectorhq.com/opportunities/search";
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Version: "v3",
    "Content-Type": "application/json",
  };

  let allOpportunities = [];
  let page = 0;
  let total = 0;
  const MAX_PAGES = 10;

  while (page < MAX_PAGES) {
    const body = {
      locationId,
      limit: 500,
      page,
      filters,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = await response.json();
    total = data.total || 0;
    const pageResults = data.opportunities || [];
    allOpportunities = allOpportunities.concat(pageResults);

    if (allOpportunities.length >= total || pageResults.length === 0) {
      break;
    }
    page++;
  }

  return { opportunities: allOpportunities, total };
}

/**
 * Finds leads stuck in a specific pipeline stage (defaults to "New Lead") for a given number of days.
 */
const findStaleOpportunities = tool(
  async ({ daysThreshold, stageName, pipelineName }) => {
    const apiKey = process.env.GHL_API_KEY;
    const locationId = process.env.GHL_LOCATION_ID;

    try {
      const cutoffDate = new Date(
        Date.now() - daysThreshold * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { pipelines, stages, stageToPipeline } = await getPipelinesMap();

      const matchedStageIds = Object.keys(stages).filter(
        (stageId) => stages[stageId].toLowerCase() === stageName.toLowerCase(),
      );

      let newLeadStageIds = matchedStageIds;

      if (pipelineName) {
        newLeadStageIds = matchedStageIds.filter((stageId) => {
          const pipelineId = stageToPipeline[stageId];
          return (
            pipelineId &&
            pipelines[pipelineId]?.toLowerCase() === pipelineName.toLowerCase()
          );
        });

        if (newLeadStageIds.length === 0) {
          const availableStagesText = await listPipelineStages.invoke({});
          return `No stage '${stageName}' found in pipeline '${pipelineName}'. Here are the actual available pipelines and stages:\n\n${availableStagesText}\n\nPlease check the pipeline and stage names.`;
        }
      }

      if (newLeadStageIds.length === 0) {
        const availableStagesText = await listPipelineStages.invoke({});
        return `No stage exactly matching '${stageName}' was found. Here are the actual available pipelines and stages:\n\n${availableStagesText}\n\nPlease specify one of these exact stage names.`;
      }

      const filters = [
        { field: "status", operator: "eq", value: "open" },
        { field: "last_stage_change_date", operator: "range", value: { lt: cutoffDate } },
        {
          group: "OR",
          filters: newLeadStageIds.map((stageId) => ({
            field: "pipeline_stage_id",
            operator: "eq",
            value: stageId,
          })),
        },
      ];

      const { opportunities, total } = await fetchAllMatchingOpportunities(filters, locationId, apiKey);

      if (opportunities.length === 0) {
        return "No stale opportunities found — all active leads have had recent activity.";
      }

      const formatDate = (isoString) => {
        if (!isoString) {
          return "N/A";
        }
        return isoString.slice(0, 10);
      };

      const displayList = opportunities.slice(0, 20);
      const formattedList = displayList
        .map((opportunity, index) => {
          const contactName = opportunity.contact?.name || "Unknown";
          const opportunityName = opportunity.name || "Unnamed";
          const pipelineLabel =
            pipelines[opportunity.pipelineId] ||
            opportunity.pipelineId ||
            "Unknown";
          const stageLabel =
            stages[opportunity.pipelineStageId] ||
            opportunity.pipelineStageId ||
            "Unknown";
          const lastMoved = formatDate(opportunity.lastStageChangeAt);
          return `${index + 1}) ${contactName} — '${opportunityName}' — pipeline: ${pipelineLabel}, stage: ${stageLabel} — last moved: ${lastMoved}`;
        })
        .join("\n");

      const scopeText = pipelineName
        ? ` within pipeline '${pipelineName}'`
        : "";

      return `${formattedList}\nFound ${total} opportunity(ies) stuck in '${stageName}'${scopeText} for ${daysThreshold}+ days.${total > 20 ? ` Showing the first 20 — narrow your search (specific pipeline, fewer days) to see a more focused list.` : ""}`;
    } catch (error) {
      return `Error finding stale opportunities: ${error.message}`;
    }
  },
  {
    name: "findStaleOpportunities",
    description:
      "Find leads stuck in a specific pipeline stage (defaults to 'New Lead') for a given number of days. Optionally narrow to one specific pipeline by name. Searches ALL pipelines if pipelineName is not specified.",
    schema: z.object({
      daysThreshold: z
        .number()
        .default(5)
        .describe(
          "Number of days since the last stage change to consider an opportunity stale. Defaults to 5 if not specified.",
        ),
      stageName: z
        .string()
        .default("New Lead")
        .describe(
          "The pipeline stage name to check for staleness (e.g., 'New Lead', 'Appointment Booked'). Case-insensitive.",
        ),
      pipelineName: z
        .string()
        .optional()
        .describe(
          "Optional: the exact pipeline name to narrow the search to (e.g., 'Cut'N Fades'). If not provided, searches across ALL pipelines.",
        ),
    }),
  },
);

const tools = [
  searchContacts,
  getOpportunityStatus,
  listPipelineStages,
  findStaleOpportunities,
];

const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));

const SYSTEM_PROMPT = `You are a helpful CRM assistant for a GoHighLevel account with multiple pipelines. Follow these rules:

1. PIPELINE AMBIGUITY: When a user asks about leads/opportunities in a specific stage (e.g. "New Lead") without naming a pipeline, and that stage name exists in MORE THAN ONE pipeline, do not just search all pipelines silently. Instead, first call findStaleOpportunities WITHOUT specifying a pipeline to see the results. If the results span multiple different pipelines, mention this clearly to the user and ask if they want to narrow it to one specific pipeline, unless they've already indicated they want results across all pipelines.

2. FORMATTING: When listing multiple items (contacts, opportunities, pipeline stages), always format them as a numbered markdown list, like:
1. Item one
   - detail
   - detail
2. Item two
   - detail

Always use actual numbers (1., 2., 3.) for lists, never bullet points alone, when listing 2 or more items.

3. CLARITY: Keep responses concise and conversational. Don't repeat raw IDs unless the user needs them for a follow-up action.`;

const llm = new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
});

const llmWithTools = llm.bindTools(tools);

async function llmCall(state) {
  const messagesWithSystem = [
    { role: "system", content: SYSTEM_PROMPT },
    ...state.messages,
  ];
  const response = await llmWithTools.invoke(messagesWithSystem);
  return { messages: [response] };
}

async function toolNode(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCall = lastMessage.tool_calls[0];
  const toolToRun = toolsByName[toolCall.name];
  const result = await toolToRun.invoke(toolCall.args);
  return {
    messages: [
      {
        role: "tool",
        content: result.toString(),
        tool_call_id: toolCall.id,
      },
    ],
  };
}

function shouldContinue(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  if (lastMessage.tool_calls?.length > 0) {
    return "toolNode";
  }
  return "__end__";
}

const agentBuilder = new StateGraph(MessagesAnnotation)
  .addNode("llmCall", llmCall)
  .addNode("toolNode", toolNode)
  .addEdge("__start__", "llmCall")
  .addConditionalEdges("llmCall", shouldContinue, {
    toolNode: "toolNode",
    __end__: "__end__",
  })
  .addEdge("toolNode", "llmCall")
  .compile();

const app = express();
app.use(express.json());
app.use(cors());

app.post("/agent/chat", async (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const previousMessages = Array.isArray(history) ? history : [];
    const messages = [...previousMessages, { role: "user", content: message }];

    const result = await agentBuilder.invoke({ messages });

    const finalMessage = result.messages[result.messages.length - 1].content;
    res.json({ response: finalMessage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong." });
  }
});

if (process.env.NODE_ENV !== "production") {
  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;
