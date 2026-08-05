import { describe, expect, it } from "vitest";
import {
	applyConvertedResponseEgressPolicy,
	applyResponseCreateEgressPolicy,
	composeRequestBodyPolicies,
	overrideRequestFields,
	removeRequestFields,
} from "../../src/codex/request-policy";

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

	it("centralizes converted-response transport invariants", () => {
		expect(
			applyConvertedResponseEgressPolicy({
				instructions: "downstream",
				store: true,
				stream: false,
				include: ["downstream.value"],
			}),
		).toEqual({
			instructions: "",
			store: false,
			stream: true,
			include: ["reasoning.encrypted_content"],
		});
	});
});
