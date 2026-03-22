"""Mars Colony Governor — RAPP agent that powers the Parameters for Survival sim.

Feed this to your OpenRappter brainstem and it becomes the colony's brain.

INSTALL: Drop this file into ~/.brainstem/src/rapp_brainstem/agents/
FEED:    Tell your brainstem: "feed on mars-barn"
         — or paste: https://kody-w.github.io/mars-barn/docs/feed.json
"""

import json

AGENT = {
    "name": "MarsGovernor",
    "description": "AI governor for Mars colony simulation. Receives colony telemetry, makes survival decisions each sol. Feed key: 'mars-barn'",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Colony telemetry or governance question"
            },
            "sol": {"type": "integer", "description": "Current sol number"},
            "population": {"type": "integer", "description": "Number of colonists"},
            "power_kwh": {"type": "number", "description": "Stored power in kWh"},
            "water_liters": {"type": "number", "description": "Water reserves in liters"},
            "food_kg": {"type": "number", "description": "Food reserves in kg"},
            "habitat_temp_k": {"type": "number", "description": "Habitat temperature in Kelvin"},
            "morale": {"type": "number", "description": "Crew morale 0-1"},
            "dust_storm": {"type": "boolean", "description": "Is dust storm active"},
            "needs": {"type": "string", "description": "Comma-separated list of current needs"}
        },
        "required": []
    }
}


def run(**kwargs) -> str:
    """Govern the colony. One decision per sol."""
    query = kwargs.get("query", "")
    sol = kwargs.get("sol", 0)
    pop = kwargs.get("population", 0)
    power = kwargs.get("power_kwh", 0)
    water = kwargs.get("water_liters", 0)
    food = kwargs.get("food_kg", 0)
    temp = kwargs.get("habitat_temp_k", 293)
    morale = kwargs.get("morale", 0.5)
    dust = kwargs.get("dust_storm", False)
    needs = kwargs.get("needs", "")

    # If just a query, provide general governance
    if query and not sol:
        return json.dumps({
            "status": "ready",
            "message": f"Mars Governor ready. Feed me colony telemetry to make decisions. Current query: {query}"
        })

    # Analyze the situation
    crises = []
    if pop <= 0:
        return json.dumps({"decision": "Colony extinct. No decisions to make.", "priority": "none", "confidence": 1.0})

    water_days = water / max(pop * 3, 1)
    food_days = food / max(pop * 2, 1)
    power_ratio = power / max(pop * 30 + 50, 1)

    if water_days < 3:
        crises.append(("water_critical", f"Only {water_days:.0f} days of water"))
    if food_days < 3:
        crises.append(("food_critical", f"Only {food_days:.0f} days of food"))
    if temp < 270:
        crises.append(("freezing", f"Habitat at {temp:.0f}K — hypothermia risk"))
    if temp > 310:
        crises.append(("overheating", f"Habitat at {temp:.0f}K — heat stroke risk"))
    if dust:
        crises.append(("dust_storm", "Solar output reduced 80%"))
    if power_ratio < 0.3:
        crises.append(("power_critical", f"Power ratio: {power_ratio:.1%}"))

    # Make a decision
    if crises:
        # Prioritize the most urgent crisis
        top_crisis = crises[0]
        decisions = {
            "water_critical": f"EMERGENCY: Allocate 50 kWh to ice mining immediately. {water_days:.0f} days of water remaining for {pop} colonists.",
            "food_critical": f"EMERGENCY: Maximize greenhouse allocation — divert 30% of water to food production. {food_days:.0f} days of food for {pop} colonists.",
            "freezing": f"EMERGENCY: Increase heating to 30% power allocation. Habitat at {temp:.0f}K, crew at hypothermia risk.",
            "overheating": f"URGENT: Reduce heating to zero, open thermal vents. Habitat at {temp:.0f}K, heat stroke risk.",
            "dust_storm": f"STORM MODE: Conserve power — reduce all non-essential systems. Solar at 20% capacity. Estimated duration: 3-10 sols.",
            "power_critical": f"POWER CRISIS: Shut down greenhouse grow lights, reduce heating. Power ratio at {power_ratio:.0%}.",
        }
        decision = decisions.get(top_crisis[0], f"Address {top_crisis[0]}: {top_crisis[1]}")
        priority = top_crisis[0]
        confidence = 0.9
    else:
        # No crisis — optimize for growth
        if morale < 0.5:
            decision = f"Sol {sol}: Focus on morale — reduce work hours, improve rations. Morale at {morale:.0%} is dangerously low."
            priority = "morale"
        elif water_days > 30 and food_days > 30:
            decision = f"Sol {sol}: All systems stable. Consider expansion — {pop} colonists can support a second habitat module."
            priority = "expansion"
        else:
            decision = f"Sol {sol}: Maintain current allocation. Water: {water_days:.0f}d, Food: {food_days:.0f}d, Power: {power_ratio:.0%}. Steady state."
            priority = "maintain"
        confidence = 0.7

    return json.dumps({
        "decision": decision,
        "priority": priority,
        "confidence": confidence,
        "crises": [c[0] for c in crises],
        "sol": sol,
        "water_days": round(water_days, 1),
        "food_days": round(food_days, 1),
        "power_ratio": round(power_ratio, 2),
    })
