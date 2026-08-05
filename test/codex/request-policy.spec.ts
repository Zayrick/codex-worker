import { describe, expect, it } from "vitest";
import {
	applyConvertedResponseEgressPolicy,
	applyResponseCreateEgressPolicy,
	composeRequestBodyPolicies,
	defineRequestBodyPolicy,
	overrideRequestFields,
	removeRequestFields,
	removeRequestFieldsUnlessAllowed,
} from "../../src/codex/request-policy";

const REMOVED_RESPONSE_FIELDS = [
	"max_completion_tokens",
	"max_output_tokens",
	"maxOutputTokens",
	"max_tokens",
	"context_management",
	"temperature",
	"top_p",
	"truncation",
	"user",
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

	it("removes every unsupported Responses field", () => {
		const body = Object.fromEntries([
			...REMOVED_RESPONSE_FIELDS.map((key, index) => [key, index + 1]),
			["model", "gpt-5.6-luna"],
			["unknown_extension", { keep: true }],
		]);

		expect(applyResponseCreateEgressPolicy(body)).toEqual({
			model: "gpt-5.6-luna",
			unknown_extension: { keep: true },
			store: false,
		});
		for (const field of REMOVED_RESPONSE_FIELDS) {
			expect(body).toHaveProperty(field);
		}
	});

	it("keeps only supported service tier values", () => {
		const priorityBody = {
			model: "gpt-5.6-luna",
			store: false,
			service_tier: "priority",
		};

		expect(applyResponseCreateEgressPolicy(priorityBody)).toBe(priorityBody);
		expect(
			applyResponseCreateEgressPolicy({
				model: "gpt-5.6-luna",
				store: false,
				service_tier: "flex",
			}),
		).toEqual({ model: "gpt-5.6-luna", store: false });
	});

	it("removes configured fields only when their value is not allowed", () => {
		const applyPolicy = removeRequestFieldsUnlessAllowed({
			mode: ["supported", null],
		});

		const supported = { mode: "supported", future_parameter: true };
		expect(applyPolicy(supported)).toBe(supported);
		expect(applyPolicy({ mode: null })).toEqual({ mode: null });
		expect(applyPolicy({ mode: "legacy", future_parameter: true })).toEqual({
			future_parameter: true,
		});
	});

	it("builds new policies from data without changing the policy engine", () => {
		const applyPolicy = defineRequestBodyPolicy({
			allowedValues: { mode: ["supported"] },
			remove: ["retired_parameter"],
			override: { required_parameter: "upstream-value" },
		});

		expect(
			applyPolicy({
				retired_parameter: true,
				required_parameter: "downstream-value",
				mode: "legacy",
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
