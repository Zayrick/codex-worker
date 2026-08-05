import { describe, expect, it } from "vitest";
import {
	applyConvertedResponseEgressPolicy,
	applyResponseCreateEgressPolicy,
	composeRequestBodyPolicies,
	defineRequestBodyPolicy,
	overrideRequestFields,
	removeRequestFields,
} from "../../src/codex/request-policy";

const UNSUPPORTED_RESPONSE_FIELDS = [
	"max_completion_tokens",
	"max_output_tokens",
	"maxOutputTokens",
	"max_tokens",
	"context_management",
] as const;

describe("Codex request body policies", () => {
	it("composes declarative overrides and removals without mutating the downstream body", () => {
		const applyPolicy = composeRequestBodyPolicies(
			overrideRequestFields({
				store: false,
				service_tier: "priority",
			}),
			removeRequestFields("reasoning"),
		);
		const downstreamBody = {
			model: "gpt-5.6-luna",
			store: true,
			service_tier: "flex",
			reasoning: { effort: "high" },
		};

		expect(applyPolicy(downstreamBody)).toEqual({
			model: "gpt-5.6-luna",
			store: false,
			service_tier: "priority",
		});
		expect(downstreamBody).toEqual({
			model: "gpt-5.6-luna",
			store: true,
			service_tier: "flex",
			reasoning: { effort: "high" },
		});
	});

	it("returns the original body when the response-create policy is already satisfied", () => {
		const body = { model: "gpt-5.6-luna", store: false };

		expect(applyResponseCreateEgressPolicy(body)).toBe(body);
	});

	it.each([true, null, "client-value"])(
		"overrides downstream store value %j",
		(store) => {
			expect(applyResponseCreateEgressPolicy({ store })).toEqual({
				store: false,
			});
		},
	);

	it("adds store=false when the downstream body omits store", () => {
		expect(applyResponseCreateEgressPolicy({})).toEqual({ store: false });
	});

	it("removes every unsupported token-limit alias and context management field", () => {
		const body = Object.fromEntries([
			...UNSUPPORTED_RESPONSE_FIELDS.map((key, index) => [key, index + 1]),
			["model", "gpt-5.6-luna"],
			["unknown_extension", { keep: true }],
		]);

		expect(applyResponseCreateEgressPolicy(body)).toEqual({
			model: "gpt-5.6-luna",
			unknown_extension: { keep: true },
			store: false,
		});
		for (const field of UNSUPPORTED_RESPONSE_FIELDS) {
			expect(body).toHaveProperty(field);
		}
	});

	it("builds new policies from data without changing the policy engine", () => {
		const applyPolicy = defineRequestBodyPolicy({
			remove: ["retired_parameter"],
			override: { required_parameter: "upstream-value" },
		});

		expect(
			applyPolicy({
				retired_parameter: true,
				required_parameter: "downstream-value",
				future_parameter: "preserved",
			}),
		).toEqual({
			required_parameter: "upstream-value",
			future_parameter: "preserved",
		});
	});

	it("centralizes converted-response transport invariants", () => {
		expect(
			applyConvertedResponseEgressPolicy({
				instructions: "downstream",
				store: true,
				stream: false,
				include: ["downstream.value"],
				max_tokens: 1024,
				context_management: [{ type: "compaction" }],
			}),
		).toEqual({
			instructions: "",
			store: false,
			stream: true,
			include: ["reasoning.encrypted_content"],
		});
	});
});
