
from agent.socratic_engine import SocraticEngine


def main():

    assistant = SocraticEngine()

    print("=== Socratic Lab Assistant ===")
    print("Type 'exit' to quit.\n")

    while True:

        question = input("Student: ")

        if question.lower() == "exit":
            break

        try:
            answer = assistant.get_response(question)
            print("\nAssistant:", answer, "\n")

        except Exception as e:
            print("Error:", e)


if __name__ == "__main__":
    main()
