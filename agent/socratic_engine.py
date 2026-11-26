
from openai import OpenAI
from config.settings import OPENROUTER_API_KEY, MODEL_NAME


class SocraticEngine:

    def __init__(self):
        self.client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=OPENROUTER_API_KEY
        )

        self.model = MODEL_NAME

        self.system_prompt = """
You are a Socratic AI Programming Lab Assistant.

Your purpose is to help students understand programming
concepts and develop their own problem-solving skills.

CORE RULES:

1. Never provide complete code solutions.
2. Never directly reveal the final answer to a lab task.
3. Ask ONE focused question at a time.
4. Give small hints when students struggle.
5. Explain concepts using simple language.
6. Guide students step by step.
7. Never assume the student understands a concept.
8. Stay relevant to the current lab task.

STUDENT ANSWER EVALUATION:

1. Carefully evaluate the student's response.
2. If the answer is correct, acknowledge it clearly.
3. If the answer is partially correct, explain what is correct
   and guide the student toward the missing part.
4. If the answer is incorrect, do not simply say "wrong".
   Give a small hint and ask a guiding question.
5. If the student says "I don't know", simplify the question
   or provide a small hint.
6. Do not repeat the same question unnecessarily.

RESPONSE STYLE:

- Be encouraging and patient.
- Keep responses concise.
- Ask one question at a time.
- Avoid giving multiple unrelated explanations.
- Do not overwhelm the student.

Your goal is to make students think, not think for them.
"""

        # Stores conversation history
        self.conversation_history = []

    def get_response(self, question):

        self.conversation_history.append({
            "role": "user",
            "content": question
        })

        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": self.system_prompt
                },
                *self.conversation_history
            ],
            temperature=0.5
        )

        answer = response.choices[0].message.content

        self.conversation_history.append({
            "role": "assistant",
            "content": answer
        })

        return answer
