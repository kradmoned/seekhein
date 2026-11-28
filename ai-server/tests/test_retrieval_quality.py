from rag.retriever import retrieve


def test_retrieval_quality():
    questions = [
        "How do I reverse an array?",
        "How do I swap two arrays?",
        "How do I find the maximum element in an array?",
        "How do I store even and odd numbers separately?"
    ]

    for question in questions:
        result = retrieve(question, lab_id="cfp_lab_3")

        print(f"\nQUESTION: {question}")
        for context in result["context"]:
            print(context[:300])